import type { Database } from "bun:sqlite";
import { type Change, parseData } from "./apply";
import { type Ctx, keyOf, labelHolds, pageCtx } from "./inbound-refs";
import { type Row, specOf } from "./schema";

// What a grantee may write into a project it was granted. Orgs, projects and grants stay with the
// home; the grantee's own stub-org members are the one exception (see membersOk), because a
// comment or message needs its author to exist here.
const WRITABLE = new Set(["tasks", "task_deps", "comments", "messages", "notes"]);

type Mode = "none" | "read" | "write" | "copy";

function projectOrg(ctx: Ctx, projectId: string): string | null {
  const stored = ctx.db
    .query<{ org_id: string }, [string]>("SELECT org_id FROM projects WHERE id = ?")
    .get(projectId)?.org_id;
  const incoming = ctx.incoming.get(`projects:${projectId}`)?.org_id;
  return stored ?? (typeof incoming === "string" ? incoming : null);
}

// `own` is the row under judgment when it is a project: a project not stored here is the peer's copy
// only if the peer says so, in that row or in a project row of this page that passed.
function modeOf(ctx: Ctx, projectId: string, own: Row | null = null): Mode {
  const project = ctx.db
    .query<{ home_instance: string | null }, [string]>(
      "SELECT home_instance FROM projects WHERE id = ?",
    )
    .get(projectId);
  if (!project) {
    const sent = own?.id === projectId ? own : ctx.incoming.get(`projects:${projectId}`);
    return sent?.home_instance === ctx.peerId ? "copy" : "none";
  }
  if (project.home_instance === ctx.peerId) return "copy";
  if (project.home_instance !== null) return "none";
  const grant = ctx.db
    .query<{ permission: "read" | "write" }, [string, string]>(
      `SELECT g.permission FROM grants g JOIN orgs o ON o.id = g.org_id
       WHERE g.project_id = ? AND o.home_instance = ?`,
    )
    .get(projectId, ctx.peerId);
  return grant?.permission ?? "none";
}

const isLocalOrg = (db: Database, orgId: Row[string] | undefined): boolean =>
  db.query("SELECT 1 FROM orgs WHERE id = ? AND home_instance IS NULL").get(orgId ?? null) !== null;

// An org that already exists here may be written by a peer only if that peer wrote it last, it is
// not a local org, and it holds no grant on a local project (those are the stubs standing for
// other peers). Otherwise a home could take over grants this instance gave to someone else.
function peerOwnsOrg(ctx: Ctx, orgId: string): boolean {
  const stored = ctx.db
    .query<{ home_instance: string | null; origin_instance: string | null }, [string]>(
      "SELECT home_instance, origin_instance FROM orgs WHERE id = ?",
    )
    .get(orgId);
  if (!stored) return true;
  if (stored.home_instance === null || stored.origin_instance !== ctx.peerId) return false;
  return (
    ctx.db
      .query(
        `SELECT 1 FROM grants g JOIN projects p ON p.id = g.project_id
         WHERE g.org_id = ? AND p.home_instance IS NULL`,
      )
      .get(orgId) === null
  );
}

// home_instance cannot be null on the wire (the sender fills in its own id), and it never changes.
function orgsOk(ctx: Ctx, change: Change, row: Row | null): boolean {
  if (!peerOwnsOrg(ctx, change.row_id)) return false;
  if (row === null) return true;
  const stored = ctx.db
    .query<{ home_instance: string | null }, [string]>(
      "SELECT home_instance FROM orgs WHERE id = ?",
    )
    .get(change.row_id);
  return (
    typeof row.home_instance === "string" && (!stored || stored.home_instance === row.home_instance)
  );
}

function membersOk(ctx: Ctx, mode: Mode, change: Change, row: Row | null): boolean {
  const stored = ctx.db
    .query<{ org_id: string }, [string]>("SELECT org_id FROM members WHERE id = ?")
    .get(change.row_id)?.org_id;
  const orgId = row ? row.org_id : stored;
  if (typeof orgId !== "string" || (stored !== undefined && stored !== orgId)) return false;
  if (mode === "copy") return peerOwnsOrg(ctx, orgId);
  const home = ctx.db
    .query<{ home_instance: string | null }, [Row[string]]>(
      "SELECT home_instance FROM orgs WHERE id = ?",
    )
    .get(orgId)?.home_instance;
  return mode === "write" && home === ctx.peerId;
}

// A write peer may only speak as someone from its own stub org, stored here or sent in a member row
// of this page. That row need not have passed: a member change goes out once per shared project, so
// the copy labelled with a read grant is refused while the person is the same.
function memberOfPeer(ctx: Ctx, memberId: Row[string] | undefined): boolean {
  if (typeof memberId !== "string") return false;
  const orgId =
    ctx.db
      .query<{ org_id: string }, [string]>("SELECT org_id FROM members WHERE id = ?")
      .get(memberId)?.org_id ?? ctx.members.get(memberId)?.org_id;
  if (typeof orgId !== "string") return false;
  return (
    ctx.db.query("SELECT 1 FROM orgs WHERE id = ? AND home_instance = ?").get(orgId, ctx.peerId) !==
    null
  );
}

// Deleting a task or root message cascades into home rows, and a peer could re-point one under its
// own first, so a peer deletes neither and cannot change parent_id/thread_root_id, nor move a stored
// row to another project or channel.
function messageAuthorOk(ctx: Ctx, rowId: string, row: Row | null): boolean {
  const stored = ctx.db
    .query<
      { author_id: string | null; thread_root_id: string | null; channel_id: string },
      [string]
    >("SELECT author_id, thread_root_id, channel_id FROM messages WHERE id = ?")
    .get(rowId);
  if (stored && !memberOfPeer(ctx, stored.author_id)) return false;
  if (row === null) return !stored || stored.thread_root_id !== null;
  if (stored && (row.thread_root_id ?? null) !== stored.thread_root_id) return false;
  if (stored && row.channel_id !== stored.channel_id) return false;
  return memberOfPeer(ctx, row.author_id);
}

function commentAuthorOk(ctx: Ctx, rowId: string, row: Row | null): boolean {
  const stored = ctx.db
    .query<{ author_id: string | null }, [string]>("SELECT author_id FROM comments WHERE id = ?")
    .get(rowId);
  if (stored && !memberOfPeer(ctx, stored.author_id)) return false;
  return row === null || memberOfPeer(ctx, row.author_id);
}

// A task's creator is provenance: a stored task keeps its creator and parent, a new one names a
// member of the peer's stub org. Tasks are never deleted.
function taskAuthorOk(ctx: Ctx, rowId: string, row: Row | null): boolean {
  const stored = ctx.db
    .query<{ created_by: string; parent_id: string | null; project_id: string }, [string]>(
      "SELECT created_by, parent_id, project_id FROM tasks WHERE id = ?",
    )
    .get(rowId);
  if (row === null) return !stored;
  if (!stored) return memberOfPeer(ctx, row.created_by);
  return (
    row.created_by === stored.created_by &&
    (row.parent_id ?? null) === stored.parent_id &&
    row.project_id === stored.project_id
  );
}

// Comments and messages stay with their author: the stored row (if any) and the incoming one must
// both be the peer's, or a write peer could rewrite or erase what a home user said.
function authorshipOk(
  ctx: Ctx,
  mode: Mode,
  table: string,
  rowId: string,
  row: Row | null,
): boolean {
  if (mode !== "write") return true;
  if (table === "comments") return commentAuthorOk(ctx, rowId, row);
  if (table === "messages") return messageAuthorOk(ctx, rowId, row);
  if (table === "tasks") return taskAuthorOk(ctx, rowId, row);
  return true;
}

// A copy's own rows must name the copy's org, and nothing a home sends may hand a local org
// access or ownership.
function rowFits(ctx: Ctx, table: string, row: Row, projectId: string): boolean {
  if (table === "projects")
    return row.home_instance === ctx.peerId && !isLocalOrg(ctx.db, row.org_id);
  if (table === "grants") return !isLocalOrg(ctx.db, row.org_id);
  if (table === "tasks" || table === "channels" || table === "notes") {
    return row.org_id === projectOrg(ctx, projectId);
  }
  return true;
}

// Rows of the tables a write peer may send, once the peer's mode and the row itself parsed.
function rowAllowed(ctx: Ctx, mode: Mode, name: string, change: Change, row: Row | null): boolean {
  if (mode === "write" && !WRITABLE.has(name)) return false;
  if (!labelHolds(ctx, name, change, row)) return false;
  if (!authorshipOk(ctx, mode, name, change.row_id, row)) return false;
  return row === null || rowFits(ctx, name, row, change.project_id);
}

function permitted(ctx: Ctx, change: Change, row: Row | null): boolean {
  const spec = specOf(change.table_name);
  if (!spec || change.origin_instance !== ctx.peerId) return false;
  if (change.op === "put" && row === null) return false;
  const mode = modeOf(ctx, change.project_id, spec.name === "projects" ? row : null);
  if (mode === "none" || mode === "read") return false;
  if (spec.name === "orgs") return mode === "copy" && orgsOk(ctx, change, row);
  if (spec.name === "members") return membersOk(ctx, mode, change, row);
  return rowAllowed(ctx, mode, spec.name, change, row);
}

// Leases belong to the home: a write peer's copy of a task is stale about who holds it, so holder
// and checkout time are replaced by what is stored here. Only /federation/lease changes them.
function keepHome(ctx: Ctx, change: Change): Change {
  if (change.table_name !== "tasks" || change.op !== "put" || change.data === null) return change;
  if (modeOf(ctx, change.project_id) !== "write") return change;
  const stored = ctx.db
    .query<{ holder_id: string | null; checked_out_at: number | null }, [string]>(
      "SELECT holder_id, checked_out_at FROM tasks WHERE id = ?",
    )
    .get(change.row_id);
  const data = JSON.parse(change.data) as Row;
  data.holder_id = stored?.holder_id ?? null;
  data.checked_out_at = stored?.checked_out_at ?? null;
  return { ...change, data: JSON.stringify(data) };
}

// Everything a peer sends is judged here before applyBatch sees it: who it claims to be, which
// project it touches (from the row itself, never from the label alone) and whether this instance
// gave that peer the right to write there. A row of the page only counts as evidence for another
// once it has passed itself and its key is not put twice with different evidence, so the page is
// judged in rounds until one passes nothing new, and the order the peer sent it in does not matter.
export function permitInbound(
  db: Database,
  peerId: string,
  changes: readonly Change[],
): { allowed: Change[]; dropped: number } {
  const rows = changes.map((change) => {
    const spec = specOf(change.table_name);
    return spec && change.op === "put" ? parseData(spec, change) : null;
  });
  const ctx = pageCtx(db, peerId, changes, rows);
  const passed = new Set<number>();
  for (let grew = true; grew; ) {
    grew = false;
    changes.forEach((change, i) => {
      const row = rows[i] ?? null;
      if (passed.has(i) || !permitted(ctx, change, row)) return;
      passed.add(i);
      if (row && !ctx.ambiguous.has(keyOf(change))) ctx.incoming.set(keyOf(change), row);
      grew = true;
    });
  }
  const allowed = changes.filter((_, i) => passed.has(i)).map((c) => keepHome(ctx, c));
  return { allowed, dropped: changes.length - allowed.length };
}
