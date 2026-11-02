import type { Database } from "bun:sqlite";
import type { ChannelKind, ChannelView, MessageView } from "../../../shared/chat";
import { personOf } from "../orgs/api";

type Raw = Record<string, string | number | null>;

const channelView = (r: Raw, unread = 0): ChannelView => ({
  id: r.id as string,
  orgId: r.org_id as string,
  kind: r.kind as ChannelKind,
  name: r.name as string,
  teamId: r.team_id as string | null,
  projectId: r.project_id as string | null,
  createdAt: r.created_at as number,
  unread,
});

export function getChannel(db: Database, id: string): ChannelView | null {
  const r = db.query<Raw, [string]>("SELECT * FROM channels WHERE id = ?").get(id);
  return r ? channelView(r) : null;
}

export interface NewChannel {
  orgId: string;
  kind: ChannelKind;
  name: string;
  teamId?: string;
  projectId?: string;
  dmKey?: string;
}

export function insertChannel(db: Database, input: NewChannel): ChannelView {
  const id = Bun.randomUUIDv7();
  db.query(
    "INSERT INTO channels (id, org_id, kind, name, team_id, project_id, dm_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    input.orgId,
    input.kind,
    input.name,
    input.teamId ?? null,
    input.projectId ?? null,
    input.dmKey ?? null,
    Date.now(),
  );
  return getChannel(db, id) as ChannelView;
}

export function ensureScopedChannel(db: Database, input: NewChannel): ChannelView {
  const existing = db
    .query<Raw, [string, string, string | null, string | null]>(
      "SELECT * FROM channels WHERE kind = ? AND org_id = ? AND team_id IS ? AND project_id IS ?",
    )
    .get(input.kind, input.orgId, input.teamId ?? null, input.projectId ?? null);
  return existing ? channelView(existing) : insertChannel(db, input);
}

export function findDm(db: Database, dmKey: string): ChannelView | null {
  const r = db.query<Raw, [string]>("SELECT * FROM channels WHERE dm_key = ?").get(dmKey);
  return r ? channelView(r) : null;
}

export function addChannelMembers(db: Database, channelId: string, memberIds: string[]): void {
  const insert = db.query(
    "INSERT OR IGNORE INTO channel_members (channel_id, member_id) VALUES (?, ?)",
  );
  for (const memberId of memberIds) insert.run(channelId, memberId);
}

export function isChannelMember(db: Database, channelId: string, memberId: string): boolean {
  return (
    db
      .query("SELECT 1 FROM channel_members WHERE channel_id = ? AND member_id = ?")
      .get(channelId, memberId) !== null
  );
}

export function channelMemberIds(db: Database, channelId: string): string[] {
  return db
    .query<{ member_id: string }, [string]>(
      "SELECT member_id FROM channel_members WHERE channel_id = ?",
    )
    .all(channelId)
    .map((r) => r.member_id);
}

// Group/dm channels are visible through channel_members; the rest through org or grant scope.
export function candidateChannels(db: Database, memberId: string, orgId: string): ChannelView[] {
  return db
    .query<Raw, [string, string, string]>(
      `SELECT * FROM channels WHERE org_id = ?
         OR project_id IN (SELECT project_id FROM grants WHERE org_id = ?)
         OR id IN (SELECT channel_id FROM channel_members WHERE member_id = ?)
       ORDER BY created_at, id`,
    )
    .all(orgId, orgId, memberId)
    .map((r) => channelView(r));
}

export function unreadCount(db: Database, channelId: string, memberId: string): number {
  const row = db
    .query<{ n: number }, [string, string, string, string]>(
      `SELECT COUNT(*) AS n FROM messages
       WHERE channel_id = ? AND (author_id IS NULL OR author_id <> ?)
         AND created_at > COALESCE((SELECT last_read_at FROM channel_members
                                    WHERE channel_id = ? AND member_id = ?), 0)`,
    )
    .get(channelId, memberId, channelId, memberId);
  return row?.n ?? 0;
}

export function setLastRead(db: Database, channelId: string, memberId: string): void {
  db.query(
    `INSERT INTO channel_members (channel_id, member_id, last_read_at) VALUES (?, ?, ?)
     ON CONFLICT (channel_id, member_id) DO UPDATE SET last_read_at = excluded.last_read_at`,
  ).run(channelId, memberId, Date.now());
}

// The board slice owns `tasks`; chat links by number without importing it, and only when the
// table exists so the two slices stay independent.
export function resolveTaskIds(db: Database, orgId: string, numbers: number[]): string[] {
  if (numbers.length === 0) return [];
  const exists = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
    .get();
  if (!exists) return [];
  return db
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM tasks WHERE org_id = ? AND number IN (SELECT value FROM json_each(?))",
    )
    .all(orgId, JSON.stringify(numbers))
    .map((r) => r.id);
}

export interface NewMessage {
  channelId: string;
  authorId: string;
  body: string;
  threadRootId: string | null;
  mentions: string[];
  taskIds: string[];
}

export function insertMessage(db: Database, input: NewMessage): MessageView {
  const id = Bun.randomUUIDv7();
  db.transaction(() => {
    db.query(
      "INSERT INTO messages (id, channel_id, thread_root_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, input.channelId, input.threadRootId, input.authorId, input.body, Date.now());
    for (const memberId of input.mentions) {
      db.query("INSERT INTO message_mentions (message_id, member_id) VALUES (?, ?)").run(
        id,
        memberId,
      );
    }
    for (const taskId of input.taskIds) {
      db.query("INSERT INTO message_tasks (message_id, task_id) VALUES (?, ?)").run(id, taskId);
    }
  })();
  return getMessage(db, id) as MessageView;
}

const SELECT_MESSAGE = `SELECT m.*, (SELECT COUNT(*) FROM messages r WHERE r.thread_root_id = m.id) AS reply_count
  FROM messages m`;

export function getMessage(db: Database, id: string): MessageView | null {
  const r = db.query<Raw, [string]>(`${SELECT_MESSAGE} WHERE m.id = ?`).get(id);
  return r ? (hydrate(db, [r])[0] ?? null) : null;
}

export interface MessageQuery {
  before?: number;
  beforeId?: string;
  threadRootId?: string;
  limit?: number;
}

export function queryMessages(db: Database, channelId: string, opts: MessageQuery): MessageView[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = db
    .query<Raw, [string, string | null, number, string, number]>(
      `${SELECT_MESSAGE} WHERE m.channel_id = ? AND m.thread_root_id IS ?
       AND (m.created_at, m.id) < (?, ?) ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
    )
    .all(
      channelId,
      opts.threadRootId ?? null,
      opts.before ?? Number.MAX_SAFE_INTEGER,
      opts.beforeId ?? "",
      limit,
    );
  return hydrate(db, rows.reverse());
}

function groupBy(rows: { message_id: string; v: string }[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { message_id, v } of rows) out.set(message_id, [...(out.get(message_id) ?? []), v]);
  return out;
}

// The board owns `tasks`; the number and project are read only when that table exists.
function taskLinks(
  db: Database,
  byMessage: Map<string, string[]>,
): Map<string, { number: number; projectId: string }[]> {
  const out = new Map<string, { number: number; projectId: string }[]>();
  const exists = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
    .get();
  if (!exists) return out;
  const lookup = db.query<{ number: number; project_id: string }, [string]>(
    "SELECT number, project_id FROM tasks WHERE id = ?",
  );
  for (const [messageId, taskIds] of byMessage) {
    const found = taskIds.flatMap((id) => lookup.get(id) ?? []);
    out.set(
      messageId,
      found.map((t) => ({ number: t.number, projectId: t.project_id })),
    );
  }
  return out;
}

function hydrate(db: Database, rows: Raw[]): MessageView[] {
  const ids = JSON.stringify(rows.map((r) => r.id));
  const mentions = groupBy(
    db
      .query<{ message_id: string; v: string }, [string]>(
        "SELECT message_id, member_id AS v FROM message_mentions WHERE message_id IN (SELECT value FROM json_each(?))",
      )
      .all(ids),
  );
  const tasks = groupBy(
    db
      .query<{ message_id: string; v: string }, [string]>(
        "SELECT message_id, task_id AS v FROM message_tasks WHERE message_id IN (SELECT value FROM json_each(?))",
      )
      .all(ids),
  );
  const links = taskLinks(db, tasks);
  return rows.map((r) => ({
    id: r.id as string,
    channelId: r.channel_id as string,
    threadRootId: r.thread_root_id as string | null,
    authorId: r.author_id as string | null,
    author: personOf(db, r.author_id as string | null),
    body: r.body as string,
    createdAt: r.created_at as number,
    editedAt: r.edited_at as number | null,
    replyCount: r.reply_count as number,
    mentions: mentions.get(r.id as string) ?? [],
    taskIds: tasks.get(r.id as string) ?? [],
    tasks: links.get(r.id as string) ?? [],
  }));
}
