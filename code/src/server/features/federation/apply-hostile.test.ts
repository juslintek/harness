import type { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NoteType, noteSummarySchema } from "../../../shared/memory";
import { drainCommits, searchNotes, type Viewer } from "../memory/api";
import { applyBatch, type BatchResult, type Change, parseData } from "./apply";
import { noteBodies } from "./bodies";
import { specOf } from "./schema";
import { freshDb, hlcAt, seedProject, taskChange } from "./test-kit";

const root = mkdtempSync(join(tmpdir(), "harness-hostile-"));

afterAll(async () => {
  await drainCommits();
  rmSync(root, { recursive: true, force: true });
});

// The largest millisecond value a Date can hold.
const MAX_DATE = 8.64e15;

const put = (table: string, rowId: string, data: object): Change => ({
  project_id: "p1",
  table_name: table,
  row_id: rowId,
  op: "put",
  hlc: hlcAt(100),
  origin_instance: "inst-b",
  data: JSON.stringify(data),
});

const org = (id: string | number, slug: string): Change =>
  put("orgs", String(id), { id, slug, name: "n", home_instance: "inst-b" });

const copyProject = (id: string, orgId: string): Change =>
  put("projects", id, {
    id,
    org_id: orgId,
    key: "CPY",
    name: "n",
    home_instance: "inst-b",
    created_at: 1,
  });

const noteData = (id: string, extra: object = {}): object => ({
  id,
  disk: `orgs/o1/projects/p1/${id}.md`,
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

const note = (extra: object = {}, id = "n1"): Change => put("notes", id, noteData(id, extra));

// A note of a copy project: its path carries the org and project ids the peer chose.
const copyNote = (orgId: string, projectId: string): Change =>
  note({
    disk: `orgs/${orgId}/projects/${projectId}/n1.md`,
    org_id: orgId,
    project_id: projectId,
    body: "hello",
  });

const viewer: Viewer = {
  orgId: "o1",
  memberId: null,
  projectIds: ["p1"],
  canWriteGlobal: false,
  canWrite: true,
  actor: "u",
};

const STORED = ["orgs", "projects", "tasks", "notes", "fed_tombstones"];

// The batch applied to a fresh database; what a peer left behind is everything that differs from
// the same batch without its hostile row.
function run(changes: Change[]): {
  db: Database;
  home: string;
  result: BatchResult;
  state: object;
} {
  const db = freshDb();
  seedProject(db, { shared: true });
  const home = mkdtempSync(join(root, "home-"));
  const result = applyBatch(db, changes, noteBodies(db, home));
  const vault = join(home, "memory");
  const state = {
    rows: STORED.map((t) => db.query(`SELECT * FROM ${t}`).all()),
    index: db.query("SELECT rowid FROM notes_fts").all(),
    applying: db.query("SELECT value FROM fed_state WHERE key = 'applying'").get(),
    files: existsSync(vault) ? readdirSync(vault, { recursive: true }).sort() : [],
  };
  return { db, home, result, state };
}

type Case = [name: string, good: Change[], bad: Change];

const numericTask = (): Change => {
  const data: object = JSON.parse(taskChange("9", hlcAt(100), "n").data ?? "{}");
  return put("tasks", "9", { ...data, id: 9 });
};

const keyCases: Case[] = [
  ["orgs: numeric id, slug taken by a local org", [], org(7, "acme")],
  ["orgs: numeric id, slug taken earlier in the page", [org("o-peer", "fresh")], org(7, "fresh")],
  ["tasks: numeric id", [], numericTask()],
];

// What the note index reads back for every viewer of the project: tags with JSON.parse and
// json_each, the dates with toISOString, and the shared schema of the note list on all the rest.
// The indexer only ever writes numbers where it writes numbers, so a text date or confidence is
// refused too, even one SQLite would coerce.
const unusable: [string, object][] = [
  ["tags that are not JSON", { tags: "not json" }],
  ["tags that are a JSON object", { tags: "{}" }],
  ["tags that are not all strings", { tags: '["a",1]' }],
  ["created past the Date range", { created: 2 ** 53 }],
  ["updated past the Date range", { updated: 2 ** 53 }],
  ["updated one past the Date range", { updated: MAX_DATE + 1 }],
  ["created as text", { created: "5" }],
  ["confidence above 1", { confidence: 5 }],
  ["confidence below 0", { confidence: -0.1 }],
  ["confidence as text", { confidence: "0.5" }],
  ["type outside the list", { type: "zzz" }],
  ["title as a number", { title: 5 }],
  ["hash as a number", { hash: 5 }],
];

const noteCases: Case[] = unusable.flatMap(([name, extra]): Case[] => [
  [`notes: ${name}, with a body`, [], note({ ...extra, body: "hello" })],
  [`notes: ${name}, without a body`, [], note(extra)],
]);

const ascii = (bytes: number): string => "o".repeat(bytes);
const copyOf = (orgId: string, projectId = "pc"): Change[] => [
  org(orgId, "copy"),
  copyProject(projectId, orgId),
];

// A path of exactly `size` bytes under the local project whose segments all stay short.
const diskOfSize = (size: number): string =>
  `orgs/o1/projects/p1/${"a/".repeat(130)}${"b".repeat(size - 283)}.md`;

const pathCases: Case[] = [
  ["notes: org id of 256 bytes in the path", copyOf(ascii(256)), copyNote(ascii(256), "pc")],
  ["notes: org id of 300 bytes in the path", copyOf(ascii(300)), copyNote(ascii(300), "pc")],
  [
    "notes: project id of 256 bytes in the path",
    copyOf("oc", ascii(256)),
    copyNote("oc", ascii(256)),
  ],
  [
    "notes: file name of 256 bytes",
    [],
    note({ disk: `orgs/o1/projects/p1/${"a".repeat(253)}.md` }),
  ],
  [
    "notes: file name of 257 bytes made of 130 characters",
    [],
    note({ disk: `orgs/o1/projects/p1/${"é".repeat(127)}.md` }),
  ],
  [
    "notes: org id as a number",
    copyOf("7", "8"),
    note({ disk: "orgs/7/projects/8/n1.md", org_id: 7, project_id: "8" }),
  ],
  [
    "notes: project id as a number",
    copyOf("7", "8"),
    note({ disk: "orgs/7/projects/8/n1.md", org_id: "7", project_id: 8 }),
  ],
  ["notes: path of 513 bytes", [], note({ disk: diskOfSize(513) })],
  [
    "notes: path of 627 bytes made of 327 characters",
    [],
    note({ disk: `orgs/o1/projects/p1/${`${"é".repeat(100)}/`.repeat(3)}x.md` }),
  ],
];

const hostile: Case[] = [...keyCases, ...noteCases, ...pathCases];

test.each(hostile)(
  "%s: refused row by row, nothing stored, the rest of the page lands",
  (_name, good, bad) => {
    const valid = taskChange("t-ok", hlcAt(100), "ok");
    const control = run([...good, valid]);
    const attacked = run([...good, bad, valid]);
    expect(attacked.result).toEqual({ ...control.result, rejected: 1 });
    expect(control.result.applied).toBe(good.length + 1);
    expect(attacked.state).toEqual(control.state);
  },
);

const accepted: [string, Change[]][] = [
  ["file name of 255 bytes", [note({ disk: `orgs/o1/projects/p1/${"a".repeat(252)}.md` })]],
  [
    "file name of 255 bytes made of 129 characters",
    [note({ disk: `orgs/o1/projects/p1/${"é".repeat(126)}.md` })],
  ],
  ["path of 512 bytes", [note({ disk: diskOfSize(512) })]],
];

test.each(accepted)("a note at the limit still applies: %s", (_name, changes) => {
  const { result } = run(changes);
  expect(result).toEqual({ applied: changes.length, stale: 0, rejected: 0 });
});

test("a note under an org id of 255 bytes is applied and its file written", () => {
  const { home, result } = run([...copyOf(ascii(255)), copyNote(ascii(255), "pc")]);
  expect(result).toEqual({ applied: 3, stale: 0, rejected: 0 });
  expect(readdirSync(join(home, "memory", "orgs"))).toEqual([ascii(255)]);
});

test("honest note rows apply and read back, and a UUID org with a taken slug is renamed", () => {
  const uuid = Bun.randomUUIDv7();
  const honest = [
    note(
      { tags: '["a","b"]', created: 1_700_000_000_000, updated: 1_700_000_000_001, body: "x" },
      "n1",
    ),
    note({ tags: "[]" }, "n2"),
    note({ created: -MAX_DATE, updated: MAX_DATE }, "n3"),
  ];
  const { db, result } = run([org(uuid, "acme"), ...honest]);
  expect(result).toEqual({ applied: 4, stale: 0, rejected: 0 });
  expect(db.query("SELECT slug FROM orgs WHERE id = ?").get(uuid)).toEqual({
    slug: `acme-${uuid.slice(-8)}`,
  });
  expect(
    searchNotes(db, viewer, {})
      .map((n) => n.id)
      .sort(),
  ).toEqual(["n1", "n2", "n3"]);
});

// Typed as a record so a type added to NoteType fails the build until it is listed here.
const NOTE_TYPES: Record<NoteType, true> = {
  lesson: true,
  fact: true,
  decision: true,
  howto: true,
  reference: true,
};

test("notes at the edge of what the list accepts apply and the list parses", () => {
  const edges = [
    ...Object.keys(NOTE_TYPES).map((type) => note({ type }, `type-${type}`)),
    ...[0, 0.5, 1, null].map((confidence) => note({ confidence }, `confidence-${confidence}`)),
  ];
  const { db, result } = run(edges);
  expect(result).toEqual({ applied: edges.length, stale: 0, rejected: 0 });
  const listed = searchNotes(db, viewer, { limit: 50 });
  expect(listed).toHaveLength(edges.length);
  expect(noteSummarySchema.array().safeParse(listed).success).toBe(true);
});

test("every row the indexer writes passes the notes check", () => {
  const { db, home } = run([]);
  const bodies = noteBodies(db, home);
  const spec = specOf("notes");
  if (!spec) throw new Error("no notes table");
  const texts = [
    "plain text",
    "# Title\n\n[[other]] link",
    "---\ntags: [a, b]\ncreated: '2024-02-29T12:00:00Z'\nupdated: '2024-03-01T00:00:00Z'\n---\nbody",
    "---\ntype: decision\ntags: []\nconfidence: 0.5\nupdated: '1970-01-01T00:00:00Z'\n---\nbody",
    "---\ntags: {}\ncreated: nonsense\n---\nbody",
    "---\ntype: howto\nconfidence: 1\n---\nbody",
    "---\ntype: zzz\nconfidence: 7\n---\nbody",
  ];
  texts.forEach((text, i) => {
    const disk = `orgs/o1/projects/p1/indexed-${i}.md`;
    expect(bodies.write({ disk, org_id: "o1", project_id: "p1" }, text)).toBe(true);
    const row = db
      .query<Record<string, string | number | null>, [string]>(
        `SELECT ${spec.columns.join(", ")} FROM notes WHERE disk = ?`,
      )
      .get(disk);
    expect(row).not.toBeNull();
    expect(parseData(spec, put("notes", String(row?.id), row ?? {}))).not.toBeNull();
  });
});
