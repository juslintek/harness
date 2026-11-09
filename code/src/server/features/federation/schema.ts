import type { Database } from "bun:sqlite";

export type Cell = string | number | null;
export type Row = Record<string, Cell>;

interface Ref {
  column: string;
  table: string;
}

export interface TableSpec {
  name: string;
  pk: readonly string[];
  columns: readonly string[];
  refs: readonly Ref[];
  // Rows outside this filter stay local (project channels and notes only).
  only?: { column: string; value: string };
  // NOT NULL columns the allowlist deliberately does not carry, written on insert only.
  fill?: (row: Row) => Row;
}

// The note's file text travels as `body`. write is false when the note does not fit where its row
// says it lives; remove gets the disk path of a note the change deletes.
export interface NoteBodies {
  read(note: Row): string | null;
  write(note: Row, body: string): boolean;
  remove(disk: string): void;
}

const org = { column: "org_id", table: "orgs" };
const project = { column: "project_id", table: "projects" };
const member = (column: string): Ref => ({ column, table: "members" });

// The one allowlist of replicated tables, in dependency order (parents first). A column that is
// not listed here never leaves the instance.
export const TABLES: readonly TableSpec[] = [
  {
    name: "orgs",
    pk: ["id"],
    columns: ["id", "slug", "name", "home_instance"],
    refs: [],
    fill: () => ({ created_at: 0 }),
  },
  {
    name: "members",
    pk: ["id"],
    columns: ["id", "org_id", "kind", "handle", "display_name", "role"],
    refs: [org],
    // The table's CHECKs want an identity for each kind, so a stub gets an inert placeholder.
    fill: (r) => ({
      created_at: 0,
      ...(r.kind === "agent" ? { agent_id: `remote:${r.id}` } : { user_id: `remote:${r.id}` }),
    }),
  },
  {
    name: "projects",
    pk: ["id"],
    columns: ["id", "org_id", "key", "name", "home_instance", "created_at"],
    refs: [org],
  },
  {
    name: "grants",
    pk: ["id"],
    columns: ["id", "project_id", "org_id", "permission", "created_at"],
    refs: [project, org],
    fill: () => ({ granted_by: "remote" }),
  },
  {
    name: "tasks",
    pk: ["id"],
    columns: [
      "id",
      "org_id",
      "project_id",
      "number",
      "parent_id",
      "title",
      "description",
      "status",
      "rank",
      "assignee_id",
      "holder_id",
      "checked_out_at",
      "estimate_minutes",
      "created_by",
      "created_at",
      "updated_at",
    ],
    refs: [
      org,
      project,
      { column: "parent_id", table: "tasks" },
      member("assignee_id"),
      member("holder_id"),
    ],
  },
  {
    name: "task_deps",
    pk: ["task_id", "depends_on"],
    columns: ["task_id", "depends_on"],
    refs: [
      { column: "task_id", table: "tasks" },
      { column: "depends_on", table: "tasks" },
    ],
  },
  {
    name: "comments",
    pk: ["id"],
    columns: ["id", "task_id", "author_id", "body", "created_at"],
    refs: [{ column: "task_id", table: "tasks" }, member("author_id")],
  },
  {
    name: "channels",
    pk: ["id"],
    columns: ["id", "org_id", "kind", "name", "project_id", "created_at"],
    refs: [org, project],
    only: { column: "kind", value: "project" },
  },
  {
    name: "messages",
    pk: ["id"],
    columns: ["id", "channel_id", "thread_root_id", "author_id", "body", "created_at", "edited_at"],
    refs: [
      { column: "channel_id", table: "channels" },
      { column: "thread_root_id", table: "messages" },
      member("author_id"),
    ],
  },
  {
    // The body lives on disk and travels as `body`, through NoteBodies.
    name: "notes",
    pk: ["id"],
    columns: [
      "id",
      "disk",
      "scope",
      "org_id",
      "project_id",
      "type",
      "title",
      "tags",
      "confidence",
      "created",
      "updated",
      "hash",
      "slug",
      "title_key",
    ],
    refs: [org, project],
    only: { column: "scope", value: "project" },
  },
];

export function specOf(table: string): TableSpec | undefined {
  return TABLES.find((t) => t.name === table);
}

export function rowId(spec: TableSpec, row: Row): string {
  return spec.pk.map((c) => String(row[c])).join(":");
}

export function pkWhere(spec: TableSpec): string {
  return spec.pk.map((c) => `${c} = ?`).join(" AND ");
}

export function pkValues(id: string): string[] {
  return id.split(":");
}

export function setApplying(db: Database, on: boolean): void {
  db.run("UPDATE fed_state SET value = ? WHERE key = 'applying'", [on ? "1" : "0"]);
}
