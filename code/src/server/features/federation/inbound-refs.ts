import type { Database } from "bun:sqlite";
import type { Change } from "./apply";
import type { Row } from "./schema";

export interface Ctx {
  db: Database;
  peerId: string;
  // Rows of this page that passed, by "table:id". Only a passed row may stand in for a parent that
  // is not stored here; a refused one counts as never sent, and so does a key in `ambiguous`.
  incoming: Map<string, Row>;
  // The "table:id" of every put of the page that parsed, passed or not. Deletes and puts that do not
  // parse can never pass, so they are left out and a child does not wait for them.
  sent: Set<string>;
  // Keys the page puts twice with different evidence (see ambiguousKeys).
  ambiguous: Set<string>;
  // Every member row of the page, passed or not, ambiguous ones apart: who a member belongs to does
  // not depend on the project label its change carries.
  members: Map<string, Row>;
}

export const keyOf = (change: Change): string => `${change.table_name}:${change.row_id}`;

// The columns other rows lean on as evidence: where a parent lives, which org a member or a project
// belongs to. A project twin naming another home is refused on its own, so home_instance is no
// evidence and listing it would only make that twin cost the valid copy its children.
const EVIDENCE: Record<string, string[]> = {
  tasks: ["project_id"],
  channels: ["project_id"],
  members: ["org_id"],
  projects: ["org_id"],
};

// applyBatch keeps one twin of a key put twice, and not necessarily the one judged last here, so a
// key whose twins disagree on an evidence column is evidence for nobody. The twins themselves are
// still judged one by one.
function ambiguousKeys(changes: readonly Change[], rows: readonly (Row | null)[]): Set<string> {
  const previous = new Map<string, string>();
  const ambiguous = new Set<string>();
  changes.forEach((change, i) => {
    const row = rows[i];
    const columns = EVIDENCE[change.table_name];
    if (!row || !columns) return;
    const key = keyOf(change);
    const evidence = JSON.stringify(columns.map((column) => row[column]));
    if (previous.get(key) !== undefined && previous.get(key) !== evidence) ambiguous.add(key);
    previous.set(key, evidence);
  });
  return ambiguous;
}

export function pageCtx(
  db: Database,
  peerId: string,
  changes: readonly Change[],
  rows: readonly (Row | null)[],
): Ctx {
  const ambiguous = ambiguousKeys(changes, rows);
  const ctx: Ctx = {
    db,
    peerId,
    incoming: new Map(),
    sent: new Set(),
    ambiguous,
    members: new Map(),
  };
  changes.forEach((change, i) => {
    const row = rows[i];
    if (!row) return;
    ctx.sent.add(keyOf(change));
    if (change.table_name === "members" && !ambiguous.has(keyOf(change))) {
      ctx.members.set(change.row_id, row);
    }
  });
  return ctx;
}

// The columns that say which project a row belongs to. A number or a missing value there is
// refused, not read as "no claim".
const PROJECT_REFS: Record<string, string[]> = {
  tasks: ["project_id"],
  channels: ["project_id"],
  notes: ["project_id"],
  grants: ["project_id"],
  comments: ["task_id"],
  messages: ["channel_id"],
  task_deps: ["task_id", "depends_on"],
};

const refsAreStrings = (table: string, row: Row): boolean =>
  (PROJECT_REFS[table] ?? []).every((col) => typeof row[col] === "string");

// Rows that take their project from a parent row: [column, parent table].
const PARENTS: Record<string, [string, string][]> = {
  comments: [["task_id", "tasks"]],
  messages: [["channel_id", "channels"]],
  task_deps: [
    ["task_id", "tasks"],
    ["depends_on", "tasks"],
  ],
};

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

// A project id; null for a row that is stored here and belongs to no project (org and global notes,
// org and dm channels, the messages in them); undefined when there is no such row, or the table
// has no project to look up.
type Project = string | null | undefined;

function storedProject(db: Database, table: string, rowId: string): Project {
  const id = table === "task_deps" ? (rowId.split(":")[0] as string) : rowId;
  const sql = PROJECT_OF[table];
  if (!sql) return undefined;
  const found = db.query<{ p: string | null }, [string]>(sql).get(id);
  return found ? found.p : undefined;
}

// The stored row goes first, and a stored parent without a project ends the lookup there: a row of
// the page naming its id must not give it one. labelHolds already refuses such a row, so this is
// cheap defence in depth.
function parentProject(ctx: Ctx, table: "tasks" | "channels", id: Row[string]): Project {
  const stored = typeof id === "string" ? storedProject(ctx.db, table, id) : undefined;
  if (stored !== undefined) return stored;
  const passed = ctx.incoming.get(`${table}:${id}`)?.project_id;
  return typeof passed === "string" ? passed : undefined;
}

function projectOfRow(ctx: Ctx, table: string, row: Row): Project {
  const own = typeof row.project_id === "string" ? row.project_id : undefined;
  switch (table) {
    case "projects":
      return typeof row.id === "string" ? row.id : undefined;
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

// A child sent ahead of a parent of this page that has not passed yet is judged again once it has.
// Judged now it would find no project for the parent, and the label alone would decide.
function waitsForParent(ctx: Ctx, table: string, row: Row): boolean {
  return (PARENTS[table] ?? []).some(([column, parent]) => {
    const key = `${parent}:${row[column]}`;
    return (
      ctx.sent.has(key) &&
      !ctx.incoming.has(key) &&
      storedProject(ctx.db, parent, String(row[column])) === undefined
    );
  });
}

// The project a row really belongs to must be the one the change is labelled with. A row that is
// stored here without a project (or sits under a parent without one) belongs to nobody, so no label
// reaches it: only a row that is not stored yet, or one of the labelled project, may be touched.
export function labelHolds(ctx: Ctx, table: string, change: Change, row: Row | null): boolean {
  if (row && (!refsAreStrings(table, row) || waitsForParent(ctx, table, row))) return false;
  const stored = storedProject(ctx.db, table, change.row_id);
  const claimed = row ? projectOfRow(ctx, table, row) : stored;
  if (stored === null || claimed === null) return false;
  return (
    (claimed ?? change.project_id) === change.project_id &&
    (stored ?? change.project_id) === change.project_id
  );
}
