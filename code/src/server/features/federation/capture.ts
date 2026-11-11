import type { Database } from "bun:sqlite";
import { createHlcState, formatHlc, type Hlc, type HlcState, hlcNow, parseHlc } from "./hlc";
import {
  type NoteBodies,
  pkValues,
  pkWhere,
  type Row,
  setApplying,
  specOf,
  TABLES,
  type TableSpec,
} from "./schema";

interface Dirty {
  table_name: string;
  row_id: string;
  op: "put" | "del";
  project_id: string | null;
}

export function loadHlcState(db: Database, instanceId: string): HlcState {
  const saved = db
    .query<{ value: string }, []>("SELECT value FROM fed_state WHERE key = 'hlc'")
    .get();
  if (!saved) return createHlcState(instanceId);
  const { ms, counter } = parseHlc(saved.value);
  return createHlcState(instanceId, ms, counter);
}

export function saveHlcState(db: Database, state: HlcState): void {
  db.run("INSERT OR REPLACE INTO fed_state (key, value) VALUES ('hlc', ?)", [
    formatHlc(state.ms, state.counter, state.instanceId),
  ]);
}

function readRow(db: Database, spec: TableSpec, id: string): Row | null {
  const sql = `SELECT ${spec.columns.join(", ")} FROM ${spec.name} WHERE ${pkWhere(spec)}`;
  const row = db.query<Row, string[]>(sql).get(...pkValues(id));
  if (!row || (spec.only && row[spec.only.column] !== spec.only.value)) return null;
  return row;
}

function projectsOf(db: Database, spec: TableSpec, dirty: Dirty, row: Row | null): string[] {
  if (dirty.project_id) return [dirty.project_id];
  const orgId = spec.name === "orgs" ? dirty.row_id : row?.org_id;
  if (typeof orgId !== "string") return [];
  return db
    .query<{ project_id: string }, [string]>("SELECT project_id FROM fed_scope WHERE org_id = ?")
    .all(orgId)
    .map((r) => r.project_id);
}

function stamp(
  db: Database,
  spec: TableSpec,
  dirty: Dirty,
  row: Row | null,
  hlc: Hlc,
  origin: string,
): void {
  if (row) {
    db.run(`UPDATE ${spec.name} SET hlc = ?, origin_instance = ? WHERE ${pkWhere(spec)}`, [
      hlc,
      origin,
      ...pkValues(dirty.row_id),
    ]);
    db.run("DELETE FROM fed_tombstones WHERE table_name = ? AND row_id = ?", [
      spec.name,
      dirty.row_id,
    ]);
    return;
  }
  db.run(
    "INSERT OR REPLACE INTO fed_tombstones (table_name, row_id, hlc, origin_instance) VALUES (?, ?, ?, ?)",
    [spec.name, dirty.row_id, hlc, origin],
  );
}

function payload(
  row: Row,
  spec: TableSpec,
  instanceId: string,
  bodies: NoteBodies | undefined,
): string {
  const data: Record<string, string | number | null> = { ...row };
  // NULL means "created here", but the receiver needs to know where home is.
  if ("home_instance" in data && data.home_instance === null) data.home_instance = instanceId;
  const body = spec.name === "notes" && bodies ? bodies.read(row) : null;
  if (body !== null) data.body = body;
  return JSON.stringify(data);
}

function emit(
  db: Database,
  state: HlcState,
  bodies: NoteBodies | undefined,
  wallMs: number,
  dirty: Dirty,
): number {
  const spec = specOf(dirty.table_name);
  if (!spec) return 0;
  const row = readRow(db, spec, dirty.row_id);
  const projects = projectsOf(db, spec, dirty, row);
  if (projects.length === 0) return 0;
  const hlc = hlcNow(state, wallMs);
  stamp(db, spec, dirty, row, hlc, state.instanceId);
  const data = row ? payload(row, spec, state.instanceId, bodies) : null;
  for (const projectId of projects) {
    db.run(
      "INSERT INTO fed_changes (project_id, table_name, row_id, op, hlc, origin_instance, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [projectId, spec.name, dirty.row_id, row ? "put" : "del", hlc, state.instanceId, data],
    );
  }
  return projects.length;
}

// Turns trigger-marked rows into feed entries. Runs with applying=1 because stamping the row is itself an update.
export function flush(
  db: Database,
  state: HlcState,
  bodies?: NoteBodies,
  wallMs: number = Date.now(),
): number {
  return db.transaction(() => {
    const dirty = db
      .query<Dirty, []>("SELECT table_name, row_id, op, project_id FROM fed_dirty")
      .all()
      .sort((a, b) => order(a) - order(b));
    setApplying(db, true);
    let count = 0;
    for (const d of dirty) count += emit(db, state, bodies, wallMs, d);
    db.run("DELETE FROM fed_dirty");
    setApplying(db, false);
    saveHlcState(db, state);
    return count;
  })();
}

const order = (d: Dirty): number => TABLES.findIndex((t) => t.name === d.table_name);
