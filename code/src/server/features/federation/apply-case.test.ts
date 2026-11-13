import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { drainCommits } from "../memory/api";
import { applyBatch, type Change, parseData } from "./apply";
import { noteBodies } from "./bodies";
import { specOf, type TableSpec } from "./schema";
import { freshDb, hlcAt, seedProject } from "./test-kit";

// These checks never rely on how the disk treats case: a row that would reach a local directory
// on a case-insensitive disk must already be refused before anything is stored or written.
const root = mkdtempSync(join(tmpdir(), "harness-case-"));

afterAll(async () => {
  await drainCommits();
  rmSync(root, { recursive: true, force: true });
});

const spec = (table: string): TableSpec => {
  const found = specOf(table);
  if (!found) throw new Error(`no ${table} table`);
  return found;
};

const put = (table: string, rowId: string, data: object): Change => ({
  project_id: "p1",
  table_name: table,
  row_id: rowId,
  op: "put",
  hlc: hlcAt(100),
  origin_instance: "inst-b",
  data: JSON.stringify(data),
});

const orgRow = (id: string): Change =>
  put("orgs", id, { id, slug: `s-${id}`.slice(0, 40), name: "n", home_instance: "inst-b" });

const projectRow = (id: string, orgId: string): Change =>
  put("projects", id, {
    id,
    org_id: orgId,
    key: "CPY",
    name: "n",
    home_instance: "inst-b",
    created_at: 1,
  });

const noteRow = (extra: object = {}, id = "n1"): Change =>
  put("notes", id, {
    id,
    disk: "orgs/o1/projects/p1/n1.md",
    scope: "project",
    org_id: "o1",
    project_id: "p1",
    type: "fact",
    title: "t",
    tags: "[]",
    confidence: null,
    created: 1,
    updated: 1,
    hash: "h",
    slug: id,
    title_key: id,
    ...extra,
  });

const uuid = Bun.randomUUIDv7();
const upper = (value: string): string => value.toUpperCase();

// An id that is not made of lowercase letters, digits, "_" and "-" names no directory of its own:
// capitals fold onto another id on a case-insensitive disk, and dots or slashes climb out of the
// directory an org id is joined under.
const unfitIds: [string, string, Change][] = [
  ["an org id in capitals", "orgs", orgRow(upper(uuid))],
  ["an org id with one capital", "orgs", orgRow(`${uuid.slice(0, -1)}${upper(uuid.slice(-1))}A`)],
  ["a project id in capitals", "projects", projectRow(upper(uuid), uuid)],
  ["a project id with one capital", "projects", projectRow("Pc", uuid)],
  ["an org id that climbs out of its directory", "orgs", orgRow("../../escaped-org")],
  ["an org id of two dots", "orgs", orgRow("..")],
  ["an org id with a slash", "orgs", orgRow("a/b")],
  ["a project id with a dot", "projects", projectRow("a.b", uuid)],
  ["a project id with a space", "projects", projectRow("a b", uuid)],
];

test.each(unfitIds)("%s is refused", (_name, table, change) => {
  expect(parseData(spec(table), change)).toBeNull();
});

test("lowercase UUID org and project ids are accepted", () => {
  expect(parseData(spec("orgs"), orgRow(uuid))).not.toBeNull();
  expect(parseData(spec("projects"), projectRow(Bun.randomUUIDv7(), uuid))).not.toBeNull();
  expect(parseData(spec("orgs"), orgRow("my_org-1"))).not.toBeNull();
});

// The row says one project and its path another, so a later del or a rewrite would act on files
// that are not the row's own.
const inconsistent: [string, object][] = [
  ["the org in the path is another one", { disk: "orgs/o2/projects/p1/n1.md" }],
  ["the project in the path is another one", { disk: "orgs/o1/projects/p2/n1.md" }],
  ["the path is under the org notes", { disk: "orgs/o1/org/n1.md" }],
  ["the path is under an agent whose id is the project id", { disk: "orgs/o1/agents/p1/n1.md" }],
  ["the path is a global note", { disk: "global/n1.md" }],
  ["the project path sits under another prefix", { disk: "global/orgs/o1/projects/p1/n1.md" }],
  ["the path stops at the project folder", { disk: "orgs/o1/projects/p1/" }],
  [
    "the path has the ids in capitals and so do the columns",
    {
      disk: "orgs/O1/projects/P1/n1.md",
      org_id: "O1",
      project_id: "P1",
    },
  ],
  ["the columns hold another org", { org_id: "o2" }],
  ["the columns hold another project", { project_id: "p2" }],
];

test.each(inconsistent)("a note whose row and path disagree is refused: %s", (_name, extra) => {
  expect(parseData(spec("notes"), noteRow(extra))).toBeNull();
});

test("a note whose path matches its org and project is accepted", () => {
  expect(parseData(spec("notes"), noteRow())).not.toBeNull();
  const copy = { disk: `orgs/${uuid}/projects/${uuid}/n1.md`, org_id: uuid, project_id: uuid };
  expect(parseData(spec("notes"), noteRow(copy))).not.toBeNull();
});

type Fresh = ReturnType<typeof freshDb>;

// A local project with a note file of its own, then a page from a peer.
function receive(changes: Change[]): { db: Fresh; home: string; local: string } {
  const db = freshDb();
  seedProject(db, { shared: true });
  const home = mkdtempSync(join(root, "home-"));
  const local = join(home, "memory", "orgs/o1/projects/p1/secret.md");
  mkdirSync(dirname(local), { recursive: true });
  writeFileSync(local, "LOCAL SECRET\n");
  expect(applyBatch(db, changes, noteBodies(db, home))).toEqual({
    applied: 0,
    stale: 0,
    rejected: changes.length,
  });
  return { db, home, local };
}

const count = (db: Fresh, table: string): number =>
  db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;

// The peer's copy org and project are the local ones with their case changed: distinct rows to
// SQLite, one directory to a case-insensitive disk.
test("a copy org and project that differ from a local one only in case store and write nothing", () => {
  const [org, project] = ["O1", "P1"];
  const folded = { org_id: org, project_id: project };
  const dir = `orgs/${org}/projects/${project}`;
  const before = [
    "orgs",
    "orgs/o1",
    "orgs/o1/projects",
    "orgs/o1/projects/p1",
    "orgs/o1/projects/p1/secret.md",
  ];
  const { db, home, local } = receive([
    orgRow(org),
    projectRow(project, org),
    noteRow({ ...folded, disk: `${dir}/secret.md`, body: "PWNED" }),
    noteRow({ ...folded, disk: `${dir}/other.md` }, "n2"),
  ]);
  expect(readFileSync(local, "utf8")).toBe("LOCAL SECRET\n");
  expect(["orgs", "projects", "notes"].map((table) => count(db, table))).toEqual([2, 1, 0]);
  expect(readdirSync(join(home, "memory"), { recursive: true }).sort()).toEqual(before);
  db.close();
});

// Stored without a body, a row whose path names another org's file would hand a later del that
// file to remove.
test("a note row whose path names a local file of another org is refused and a del leaves it", () => {
  const hostile = noteRow({ org_id: "o2", disk: "orgs/o1/projects/p1/secret.md" });
  const { db, home, local } = receive([hostile]);
  applyBatch(db, [{ ...hostile, op: "del", data: null, hlc: hlcAt(200) }], noteBodies(db, home));
  expect(readFileSync(local, "utf8")).toBe("LOCAL SECRET\n");
  db.close();
});

test("a copy org and project with lowercase UUID ids apply and the note file is written", () => {
  const [org, project] = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
  const disk = `orgs/${org}/projects/${project}/n1.md`;
  const db = freshDb();
  seedProject(db, { shared: true });
  const home = mkdtempSync(join(root, "home-"));
  const page = [
    orgRow(org),
    projectRow(project, org),
    noteRow({ org_id: org, project_id: project, disk, body: "hello" }),
  ];
  expect(applyBatch(db, page, noteBodies(db, home))).toEqual({ applied: 3, stale: 0, rejected: 0 });
  expect(readFileSync(join(home, "memory", disk), "utf8")).toContain("hello");
});
