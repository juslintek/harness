import type { Database } from "bun:sqlite";
import { type Change, parseData } from "./apply";
import { type Row, specOf } from "./schema";

// What a grantee may write into a project it was granted. Orgs, projects and grants stay with the
// home; the grantee's own stub-org members are the one exception (see membersOk), because a
// comment or message needs its author to exist here.
const WRITABLE = new Set(["tasks", "task_deps", "comments", "messages", "notes"]);

type Mode = "none" | "read" | "write" | "copy";

interface Ctx {
  db: Database;
  peerId: string;
  // Rows of this page by "table:id", so a child can be judged before its parent is applied.
  incoming: Map<string, Row>;
}

const PROJECT_OF: Record<string, string> = {
  tasks: "SELECT project_id AS p FROM tasks WHERE id = ?",
  channels: "SELECT project_id AS p FROM channels WHERE id = ?",
  notes: "SELECT project_id AS p FROM notes WHERE id = ?",
  grants: "SELECT project_id AS p FROM grants WHERE id = ?",
  projects: "SELECT id AS p FROM projects WHERE id = ?",
  comments:
    "SELECT t.project_id AS p FROM comments c JOIN tasks t ON t.id = c.task_id WHERE c.id = ?",
  messages:
    "SELECT ch.project_id AS p FROM messages m JOIN channels ch ON ch.id = m.channel_id WHERE m.id = ?",
  task_deps: "SELECT project_id AS p FROM tasks WHERE id = ?",
};

function storedProject(db: Database, table: string, rowId: string): string | null {
  const id = table === "task_deps" ? (rowId.split(":")[0] as string) : rowId;
  const sql = PROJECT_OF[table];
  if (!sql) return null;
  return db.query<{ p: string }, [string]>(sql).get(id)?.p ?? null;
}

function parentProject(ctx: Ctx, table: "tasks" | "channels", id: Row[string]): string | null {
  const fromPage = ctx.incoming.get(`${table}:${id}`)?.project_id;
  if (typeof fromPage === "string") return fromPage;
  return typeof id === "string" ? storedProject(ctx.db, table, id) : null;
}

function projectOfRow(ctx: Ctx, table: string, row: Row): string | null {
  const own = typeof row.project_id === "string" ? row.project_id : null;
  switch (table) {
    case "projects":
      return typeof row.id === "string" ? row.id : null;
    case "task_deps": {
      // Both ends must sit in one project, or a dependency could reach into another.
      const of = parentProject(ctx, "tasks", row.task_id as Row[string]);
      return of === parentProject(ctx, "tasks", row.depends_on as Row[string]) ? of : "";
    }
    case "comments":
      return parentProject(ctx, "tasks", row.task_id as Row[string]);
    case "messages":
      return parentProject(ctx, "channels", row.channel_id as Row[string]);
    default:
      return own;
  }
}

function projectOrg(ctx: Ctx, projectId: string): string | null {
  const stored = ctx.db
    .query<{ org_id: string }, [string]>("SELECT org_id FROM projects WHERE id = ?")
    .get(projectId)?.org_id;
  const incoming = ctx.incoming.get(`projects:${projectId}`)?.org_id;
  return stored ?? (typeof incoming === "string" ? incoming : null);
}

function modeOf(ctx: Ctx, projectId: string): Mode {
  const project = ctx.db
    .query<{ home_instance: string | null }, [string]>(
      "SELECT home_instance FROM projects WHERE id = ?",
    )
    .get(projectId);
  if (!project) {
    return ctx.incoming.get(`projects:${projectId}`)?.home_instance === ctx.peerId
      ? "copy"
      : "none";
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

// The project a row really belongs to must be the one the change is labelled with.
function labelHolds(ctx: Ctx, table: string, change: Change, row: Row | null): boolean {
  const stored = storedProject(ctx.db, table, change.row_id);
  const claimed = row ? projectOfRow(ctx, table, row) : stored;
  return (
    (claimed ?? change.project_id) === change.project_id &&
    (stored ?? change.project_id) === change.project_id
  );
}

function permitted(ctx: Ctx, change: Change): boolean {
  const spec = specOf(change.table_name);
  if (!spec || change.origin_instance !== ctx.peerId) return false;
  const row = change.op === "put" ? parseData(spec, change) : null;
  if (change.op === "put" && row === null) return false;
  const mode = modeOf(ctx, change.project_id);
  if (mode === "none" || mode === "read") return false;
  if (spec.name === "orgs") return mode === "copy" && orgsOk(ctx, change, row);
  if (spec.name === "members") return membersOk(ctx, mode, change, row);
  if (mode === "write" && !WRITABLE.has(spec.name)) return false;
  if (!labelHolds(ctx, spec.name, change, row)) return false;
  return row === null || rowFits(ctx, spec.name, row, change.project_id);
}

// Everything a peer sends is judged here before applyBatch sees it: who it claims to be, which
// project it touches (from the row itself, never from the label alone) and whether this instance
// gave that peer the right to write there.
export function permitInbound(
  db: Database,
  peerId: string,
  changes: readonly Change[],
): { allowed: Change[]; dropped: number } {
  const incoming = new Map<string, Row>();
  for (const change of changes) {
    const spec = specOf(change.table_name);
    const row = spec && change.op === "put" ? parseData(spec, change) : null;
    if (row) incoming.set(`${change.table_name}:${change.row_id}`, row);
  }
  const ctx: Ctx = { db, peerId, incoming };
  const allowed = changes.filter((c) => permitted(ctx, c));
  return { allowed, dropped: changes.length - allowed.length };
}
