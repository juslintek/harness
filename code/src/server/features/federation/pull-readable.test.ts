import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";
import { taskViewSchema } from "../../../shared/board";
import { messageListSchema } from "../../../shared/chat";
import type { Change } from "./apply";
import { type PullStats, pullPeer } from "./pull";
import {
  answerFeed,
  api,
  beeTask,
  cursorOf,
  feedOf,
  type Node,
  peerChange,
  peerOn,
  rowsOf,
  type Seed,
  taskRow,
  writePair,
} from "./sync-kit";

const NOW = Date.now();
const UUID_V7 = "0190a5b2-7c3e-7d4f-8a1b-2c3d4e5f6a7b";

let a: Node;
let b: Node;
let seed: Seed;
let channelId: string;

beforeAll(async () => {
  ({ a, b, seed } = await writePair());
  channelId =
    a.db
      .query<{ id: string }, [string]>("SELECT id FROM channels WHERE project_id = ?")
      .get(seed.projectId)?.id ?? "";
});

afterAll(() => {
  a.stop();
  b.stop();
});

async function pullPage(changes: Change[]): Promise<{ stats: PullStats; moved: number }> {
  const before = Number(cursorOf(a, b) ?? 0);
  const feed = changes.map((c, i) => feedOf(before + i + 1, c));
  const restore = answerFeed(() => Response.json({ changes: feed, next: before + feed.length }));
  try {
    const stats = await pullPeer(a.db, a.home, peerOn(a, b));
    return { stats, moved: Number(cursorOf(a, b)) - before };
  } finally {
    restore();
  }
}

const message = (id: string, extra: object = {}): Change =>
  peerChange(b, "messages", id, seed.projectId, {
    id,
    channel_id: channelId,
    thread_root_id: null,
    author_id: "m-bee",
    body: "hello",
    created_at: NOW,
    edited_at: null,
    ...extra,
  });

const task = (id: string, extra: object): Change =>
  peerChange(b, "tasks", id, seed.projectId, {
    ...taskRow(id, seed.projectId, seed.orgId),
    created_by: "m-bee",
    ...extra,
  });

const idsOf = (table: string): string[] => rowsOf(a.db, table).map((r) => String(r.id));

test("messages and tasks the chat view and the board cannot read are refused, the page lands and the routes read what is left", async () => {
  const changes = [
    message("m-far", { created_at: 9e15 }),
    message("m-low", { created_at: -9e15 }),
    message("m-zero", { created_at: 0 }),
    message("m-edit", { edited_at: 9e15 }),
    message("m.dot"),
    message(UUID_V7, { edited_at: NOW }),
    task("t-rank", { rank: "1e999" }),
    task("t-number", { number: 2 ** 62 }),
    beeTask(b, "t-pull-ok", seed),
  ];
  const { stats, moved } = await pullPage(changes);
  expect(stats).toEqual({ applied: 2, stale: 0, rejected: 7 });
  expect(moved).toBe(changes.length);
  expect(idsOf("messages")).toEqual([UUID_V7]);
  expect(idsOf("tasks")).toContain("t-pull-ok");
  expect(idsOf("tasks")).not.toContain("t-rank");
  expect(idsOf("tasks")).not.toContain("t-number");

  const chat = await api(a, "GET", `/api/channels/${channelId}/messages`);
  const stored = messageListSchema.parse(chat.json);
  expect(stored).toHaveLength(1);
  const first = stored[0];
  const older = `/api/channels/${channelId}/messages?before=${first?.createdAt}:${first?.id}`;
  expect((await api(a, "GET", older)).status).toBe(200);
  const board = await api(a, "GET", `/api/projects/${seed.projectId}/tasks`);
  expect(z.array(taskViewSchema).safeParse(board.json).success).toBe(true);
});
