import type { Database } from "bun:sqlite";
import {
  type Cell,
  type NoteBodies,
  pkValues,
  pkWhere,
  type Row,
  rowId,
  rowIdFits,
  setApplying,
  specOf,
  TABLES,
  type TableSpec,
} from "./schema";

export interface Change {
  project_id: string;
  table_name: string;
  row_id: string;
  op: "put" | "del";
  hlc: string;
  origin_instance: string;
  data: string | null;
}

// stale: lost to what we already have. rejected: unusable here (unknown table, an id that does not fit
// the table key, a value the stores cannot read back, missing parent, constraint).
export type ApplyResult = "applied" | "stale" | "rejected";

export interface BatchResult {
  applied: number;
  stale: number;
  rejected: number;
}

interface Stamp {
  hlc: string | null;
  origin_instance: string | null;
}

function localStamp(db: Database, spec: TableSpec, id: string): Stamp | null {
  const row = db
    .query<Stamp, string[]>(`SELECT hlc, origin_instance FROM ${spec.name} WHERE ${pkWhere(spec)}`)
    .get(...pkValues(id));
  if (row) return row;
  return db
    .query<Stamp, [string, string]>(
      "SELECT hlc, origin_instance FROM fed_tombstones WHERE table_name = ? AND row_id = ?",
    )
    .get(spec.name, id);
}

function wins(change: Change, local: Stamp | null): boolean {
  if (!local || local.hlc === null) return true;
  if (change.hlc !== local.hlc) return change.hlc > local.hlc;
  return change.origin_instance < (local.origin_instance ?? "");
}

// The home instance owns its orgs and projects: a peer's copy of them cannot overwrite the original.
function ownedHere(db: Database, spec: TableSpec, id: string): boolean {
  if (spec.name !== "orgs" && spec.name !== "projects") return false;
  return (
    db.query(`SELECT 1 FROM ${spec.name} WHERE id = ? AND home_instance IS NULL`).get(id) !== null
  );
}

// Rows outside the table's filter stay local. A key that is not text would reach code that treats
// it as a string (the org slug suffix), and the table's own check refuses values the stores cannot
// read back or write to disk.
function fitsTable(spec: TableSpec, row: Row): boolean {
  if (spec.only && row[spec.only.column] !== spec.only.value) return false;
  if (!spec.pk.every((column) => typeof row[column] === "string")) return false;
  return spec.valid ? spec.valid(row) : true;
}

export function parseData(spec: TableSpec, change: Change): Row | null {
  if (change.data === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(change.data);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const row: Row = {};
  for (const [key, value] of Object.entries(data)) {
    if (!spec.columns.includes(key) && key !== "body") continue;
    if (value !== null && typeof value !== "string" && typeof value !== "number") return null;
    row[key] = value;
  }
  if (!fitsTable(spec, row)) return null;
  return rowId(spec, row) === change.row_id ? row : null;
}

function parentsPresent(db: Database, spec: TableSpec, row: Row): boolean {
  return spec.refs.every((ref) => {
    const value: Cell | undefined = row[ref.column];
    if (value === null || value === undefined) return true;
    return db.query(`SELECT 1 FROM ${ref.table} WHERE id = ?`).get(value) !== null;
  });
}

// A task hangs under a parent of its own project and a reply under a root of its own channel.
// Without it a write peer could hang a task under a row it can delete elsewhere (its copy
// project) and the cascade would take the home's comments and subtasks. It is checked here, not
// when the page is permitted, because the parent may be an earlier row of the same page.
function parentStaysPut(db: Database, spec: TableSpec, row: Row): boolean {
  if (spec.name === "tasks" && row.parent_id != null) {
    const parent = db
      .query<{ project_id: string }, [Cell]>("SELECT project_id FROM tasks WHERE id = ?")
      .get(row.parent_id);
    return parent?.project_id === row.project_id;
  }
  if (spec.name === "messages" && row.thread_root_id != null) {
    const root = db
      .query<{ channel_id: string; thread_root_id: string | null }, [Cell]>(
        "SELECT channel_id, thread_root_id FROM messages WHERE id = ?",
      )
      .get(row.thread_root_id);
    return root?.thread_root_id === null && root.channel_id === row.channel_id;
  }
  return true;
}

// A stored task keeps its project and a stored message its channel. permit judges a page against the
// state before it, so a row put twice in one page (first in the granted project, then labelled
// with the copy project) would otherwise be moved, leaving its children behind to be cascaded away
// when the copy-project label deletes it.
function staysInPlace(db: Database, spec: TableSpec, row: Row): boolean {
  const column =
    spec.name === "tasks" ? "project_id" : spec.name === "messages" ? "channel_id" : null;
  if (!column) return true;
  const stored = db
    .query<{ place: string }, [Cell]>(`SELECT ${column} AS place FROM ${spec.name} WHERE id = ?`)
    .get(row.id ?? null);
  return !stored || stored.place === row[column];
}

// slug and (org_id, number) are unique per instance, but each instance picks them on its own, so a
// replicated row can clash with a local one. The incoming row gives way: a task keeps the number it
// already has here or takes the next free one, an org gets its id appended to the slug. Dropping
// the row instead would lose the project below it.
function freeOfLocalClash(db: Database, spec: TableSpec, row: Row): Row {
  const id = row.id as string;
  const orgId = row.org_id ?? null;
  if (spec.name === "orgs" && typeof row.slug === "string") {
    const taken = db.query("SELECT 1 FROM orgs WHERE slug = ? AND id != ?").get(row.slug, id);
    return taken ? { ...row, slug: `${row.slug}-${id.slice(-8)}` } : row;
  }
  if (spec.name === "tasks") {
    const taken = db
      .query("SELECT 1 FROM tasks WHERE org_id = ? AND number = ? AND id != ?")
      .get(orgId, row.number ?? null, id);
    if (!taken) return row;
    const kept = db
      .query<{ number: number }, [string]>("SELECT number FROM tasks WHERE id = ?")
      .get(id);
    const next = db
      .query<{ n: number }, [Cell]>(
        "SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tasks WHERE org_id = ?",
      )
      .get(orgId);
    return { ...row, number: kept?.number ?? next?.n ?? 1 };
  }
  return row;
}

function upsert(db: Database, spec: TableSpec, row: Row, change: Change): void {
  const data: Row = {};
  for (const col of spec.columns) if (col in row) data[col] = row[col] as Cell;
  const stamped: Row = { ...data, hlc: change.hlc, origin_instance: change.origin_instance };
  const cols = Object.keys({ ...stamped, ...spec.fill?.(data) });
  const values = { ...stamped, ...spec.fill?.(data) };
  const update = Object.keys(stamped).filter((c) => !spec.pk.includes(c));
  db.run(
    `INSERT INTO ${spec.name} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
     ON CONFLICT (${spec.pk.join(", ")}) DO UPDATE SET ${update.map((c) => `${c} = excluded.${c}`).join(", ")}`,
    cols.map((c) => values[c] as Cell),
  );
  db.run("DELETE FROM fed_tombstones WHERE table_name = ? AND row_id = ?", [
    spec.name,
    change.row_id,
  ]);
}

function put(
  db: Database,
  spec: TableSpec,
  change: Change,
  bodies: NoteBodies | undefined,
): ApplyResult {
  const row = parseData(spec, change);
  if (!row || ownedHere(db, spec, change.row_id)) return "rejected";
  if (!wins(change, localStamp(db, spec, change.row_id))) return "stale";
  if (!parentsPresent(db, spec, row) || !parentStaysPut(db, spec, row)) return "rejected";
  if (!staysInPlace(db, spec, row)) return "rejected";
  upsert(db, spec, freeOfLocalClash(db, spec, row), change);
  // comments and messages have a `body` column of their own; only a note's body is a file.
  const fileBody = spec.name === "notes" && typeof row.body === "string" ? row.body : null;
  if (bodies && fileBody !== null && !bodies.write(row, fileBody)) throw new Unfit();
  return "applied";
}

function del(
  db: Database,
  spec: TableSpec,
  change: Change,
  bodies: NoteBodies | undefined,
): ApplyResult {
  if (ownedHere(db, spec, change.row_id)) return "rejected";
  if (!wins(change, localStamp(db, spec, change.row_id))) return "stale";
  if (spec.name === "notes" && bodies) {
    const note = db
      .query<{ disk: string }, [string]>("SELECT disk FROM notes WHERE id = ?")
      .get(change.row_id);
    if (note) bodies.remove(note.disk);
  }
  db.run(`DELETE FROM ${spec.name} WHERE ${pkWhere(spec)}`, pkValues(change.row_id));
  db.run(
    "INSERT OR REPLACE INTO fed_tombstones (table_name, row_id, hlc, origin_instance) VALUES (?, ?, ?, ?)",
    [spec.name, change.row_id, change.hlc, change.origin_instance],
  );
  return "applied";
}

// A note body that does not belong where its row says: the row is rolled back with it.
class Unfit extends Error {}

function isConstraint(e: unknown): boolean {
  const code = (e as { code?: unknown }).code;
  return e instanceof Unfit || (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT"));
}

export function applyChange(db: Database, change: Change, bodies?: NoteBodies): ApplyResult {
  const spec = specOf(change.table_name);
  if (!spec || !rowIdFits(spec, change.row_id)) return "rejected";
  try {
    return db.transaction(() => {
      setApplying(db, true);
      const result =
        change.op === "put" ? put(db, spec, change, bodies) : del(db, spec, change, bodies);
      setApplying(db, false);
      return result;
    })();
  } catch (e) {
    // The transaction rolled back, including applying=1, so only this row is lost.
    if (isConstraint(e)) return "rejected";
    throw e;
  }
}

export function applyBatch(
  db: Database,
  changes: readonly Change[],
  bodies?: NoteBodies,
): BatchResult {
  const index = (c: Change): number => TABLES.findIndex((t) => t.name === c.table_name);
  const result: BatchResult = { applied: 0, stale: 0, rejected: 0 };
  for (const change of [...changes].sort((a, b) => index(a) - index(b))) {
    result[applyChange(db, change, bodies)] += 1;
  }
  return result;
}
