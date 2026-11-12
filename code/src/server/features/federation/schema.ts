import type { Database } from "bun:sqlite";
import { noteSummarySchema } from "../../../shared/memory";

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
  // False for a row the local stores could not read back or write to disk.
  valid?: (row: Row) => boolean;
}

// The note's file text travels as `body`. write is false when the note does not fit where its row
// says it lives; remove gets the disk path of a note the change deletes.
export interface NoteBodies {
  read(note: Row): string | null;
  write(note: Row, body: string): boolean;
  remove(disk: string): void;
}

// A peer picks the org and project ids that a note's `disk` carries, and the note store makes a
// directory for each. A name over 255 bytes (NAME_MAX: 255 is written, 256 fails with ENAMETOOLONG)
// throws out of the page transaction. The whole path gets 512 bytes, half of macOS PATH_MAX, which
// leaves the rest for where the vault lives and is above the 288 bytes of two UUIDs plus a note
// path of 200 characters.
const NAME_MAX_BYTES = 255;
const DISK_MAX_BYTES = 512;

function isTagList(value: Cell | undefined): boolean {
  if (typeof value !== "string") return false;
  try {
    const tags: unknown = JSON.parse(value);
    return Array.isArray(tags) && tags.every((tag) => typeof tag === "string");
  } catch {
    return false;
  }
}

const isDate = (value: Cell | undefined): boolean =>
  typeof value === "number" && Number.isFinite(new Date(value).getTime());

const diskFits = (disk: Cell | undefined): boolean =>
  typeof disk === "string" &&
  Buffer.byteLength(disk) <= DISK_MAX_BYTES &&
  disk.split("/").every((name) => Buffer.byteLength(name) <= NAME_MAX_BYTES);

// The note as the list, detail and backlinks routes serve it (toIndexed in the memory slice does
// the same renaming). The web parses a whole list with noteSummarySchema, so one stored row that
// it refuses, such as a confidence of 5 or an unknown type, breaks the list for every viewer.
// Parsing with the schema itself keeps its enums and ranges out of this file. Tags and dates have
// to pass their own checks first, or building the value would throw.
const parsesAsSummary = (row: Row): boolean =>
  noteSummarySchema.safeParse({
    id: row.id,
    path: row.disk,
    scope: row.scope,
    orgId: row.org_id,
    projectId: row.project_id,
    memberId: null,
    type: row.type,
    title: row.title,
    tags: JSON.parse(String(row.tags)),
    sourceAgent: "outside",
    confidence: row.confidence ?? 1,
    created: new Date(Number(row.created)).toISOString(),
    updated: new Date(Number(row.updated)).toISOString(),
    hash: row.hash,
  }).success;

// Ids name directories (the note vault, the scratch repo of an org), so a peer's id stays within
// the characters the vault accepts. Lowercase only: a case-insensitive disk (macOS, Windows)
// resolves two ids that differ only in case to one directory, SQLite keeps them apart, and a peer's
// "ABC" would write over and delete the notes of the local "abc". Honest ids are lowercase UUIDs.
const plainId = (row: Row): boolean => /^[a-z0-9_-]+$/.test(String(row.id));

// The path the note store gives a project note: the org and project directories, then the file.
// diskToLocated in the memory slice parses the same shape but its api does not export it. The
// store checks the rest of the path on every file operation; here the directories have to be the
// row's own, or a bodyless row could name another project's files and a later del would reach them.
const PROJECT_NOTE_DIRS = /^orgs\/([a-z0-9_-]+)\/projects\/([a-z0-9_-]+)\/./;

function diskMatchesRow(row: Row): boolean {
  const dirs = typeof row.disk === "string" ? PROJECT_NOTE_DIRS.exec(row.disk) : null;
  return dirs !== null && dirs[1] === row.org_id && dirs[2] === row.project_id;
}

// Every viewer of the project lists its notes through JSON.parse and json_each on the tags and
// toISOString on both dates, so a stored row that fails there breaks the listing for all of them.
const noteReadable = (row: Row): boolean =>
  isTagList(row.tags) &&
  isDate(row.created) &&
  isDate(row.updated) &&
  diskFits(row.disk) &&
  diskMatchesRow(row) &&
  parsesAsSummary(row);

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
    valid: plainId,
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
    valid: plainId,
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
    valid: noteReadable,
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

// rowId joins n key values with n-1 colons, so the id splits back into n parts only if none of
// the values held a colon. A peer picks its row ids, and one that does not fit would bind the
// wrong number of values to the key query, which throws instead of failing a constraint.
export function rowIdFits(spec: TableSpec, id: string): boolean {
  return pkValues(id).length === spec.pk.length;
}

export function setApplying(db: Database, on: boolean): void {
  db.run("UPDATE fed_state SET value = ? WHERE key = 'applying'", [on ? "1" : "0"]);
}
