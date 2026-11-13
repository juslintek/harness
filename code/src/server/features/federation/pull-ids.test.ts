import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Change } from "./apply";
import { type PullStats, pullPeer } from "./pull";
import {
  answerFeed,
  beeTask,
  cursorOf,
  feedOf,
  type Node,
  peerChange,
  peerOn,
  rowsOf,
  type Seed,
  writePair,
} from "./sync-kit";

let a: Node;
let b: Node;
let seed: Seed;

beforeAll(async () => {
  ({ a, b, seed } = await writePair());
});

afterAll(() => {
  a.stop();
  b.stop();
});

// Each of these has a label and a body that agree and passes the permission filter, so only apply
// can refuse them. Unrefused, the first one throws out of the pull transaction on every round.
test("a page with colon row ids is refused row by row and the valid row still lands", async () => {
  const forged = (table: string, rowId: string, data: object): Change =>
    peerChange(b, table, rowId, seed.projectId, data);
  const changes = [
    beeTask(b, "x:y", seed),
    { ...forged("tasks", "x:z", {}), op: "del" as const, data: null },
    beeTask(b, "t-ok", seed),
    forged("task_deps", "t-ok:x:y", { task_id: "t-ok", depends_on: "x:y" }),
  ];
  const page = { changes: changes.map((c, i) => feedOf(i + 1, c)), next: changes.length };
  const restore = answerFeed(() => Response.json(page));
  try {
    const stats = await pullPeer(a.db, a.home, peerOn(a, b));
    expect(stats).toEqual({ applied: 1, stale: 0, rejected: 3 });
  } finally {
    restore();
  }
  expect(rowsOf(a.db, "tasks").map((t) => t.id)).toEqual(["t-ok"]);
  expect(rowsOf(a.db, "task_deps")).toEqual([]);
  expect(a.db.query("SELECT 1 FROM fed_tombstones").get()).toBeNull();
  expect(cursorOf(a, b)).toBe(String(changes.length));
});

// Numbered after the cursor, so a page only counts as taken in once the cursor has moved past it.
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

const storedIds = (table: string): string[] => rowsOf(a.db, table).map((r) => String(r.id));

// A copy of a peer org and its project, as the peer's own feed carries them: both labelled with the project.
const copyOrg = (id: string | number, slug: string, project = "p-copy"): Change =>
  peerChange(b, "orgs", String(id), project, { id, slug, name: "n", home_instance: b.instanceId });

const copyProject = (orgId: string, id: string): Change =>
  peerChange(b, "projects", id, id, {
    id,
    org_id: orgId,
    key: "CPY",
    name: "Copy",
    home_instance: b.instanceId,
    created_at: 1,
  });

const noteOf = (id: string, extra: object): Change =>
  peerChange(b, "notes", id, seed.projectId, {
    id,
    disk: `orgs/${seed.orgId}/projects/${seed.projectId}/${id}.md`,
    scope: "project",
    org_id: seed.orgId,
    project_id: seed.projectId,
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

// Values the stores cannot read back used to throw out of the page transaction on every round, so
// the cursor never moved. Each page carries one valid task that has to land next to the refusals.
test("an org with a numeric id and a taken slug is refused and the page still lands", async () => {
  const changes = [
    copyOrg("o-peer", "zz-slug"),
    copyProject("o-peer", "p-copy"),
    copyOrg(7, "zz-slug"),
    beeTask(b, "t-org", seed),
  ];
  const { stats, moved } = await pullPage(changes);
  expect(stats).toEqual({ applied: 3, stale: 0, rejected: 1 });
  expect(moved).toBe(changes.length);
  expect(storedIds("orgs")).not.toContain("7");
  expect(storedIds("tasks")).toContain("t-org");
});

test("notes whose tags or dates cannot be read back are refused and the page still lands", async () => {
  const changes = [
    noteOf("n-tags", { tags: "not json", body: "hello" }),
    noteOf("n-date", { updated: 2 ** 53 }),
    beeTask(b, "t-notes", seed),
  ];
  const { stats, moved } = await pullPage(changes);
  expect(stats).toEqual({ applied: 1, stale: 0, rejected: 2 });
  expect(moved).toBe(changes.length);
  expect(storedIds("notes")).toEqual([]);
  expect(storedIds("tasks")).toContain("t-notes");
});

test("a note path with a name over the file system limit is refused and the page still lands", async () => {
  const long = "o".repeat(300);
  const changes = [
    copyOrg(long, "zz-long", "p-long"),
    copyProject(long, "p-long"),
    peerChange(b, "notes", "n-long", "p-long", {
      id: "n-long",
      disk: `orgs/${long}/projects/p-long/x.md`,
      scope: "project",
      org_id: long,
      project_id: "p-long",
      type: "fact",
      title: "t",
      tags: "[]",
      confidence: null,
      created: 1,
      updated: 1,
      hash: "h",
      slug: "x",
      title_key: "x",
      body: "hello",
    }),
    beeTask(b, "t-long", seed),
  ];
  const { stats, moved } = await pullPage(changes);
  expect(stats).toEqual({ applied: 3, stale: 0, rejected: 1 });
  expect(moved).toBe(changes.length);
  expect(storedIds("notes")).toEqual([]);
  expect(storedIds("tasks")).toContain("t-long");
});

// Stored as sent, the first two would fail the shared schema that every viewer's note list parses.
// Last in the file because the edge note stays behind and an earlier test expects no notes.
test("notes the note list cannot parse are refused and the page still lands", async () => {
  const changes = [
    noteOf("n-confidence", { confidence: 5 }),
    noteOf("n-type", { type: "zzz", body: "hello" }),
    noteOf("n-edge", { confidence: 1, type: "reference" }),
    beeTask(b, "t-list", seed),
  ];
  const { stats, moved } = await pullPage(changes);
  expect(stats).toEqual({ applied: 2, stale: 0, rejected: 2 });
  expect(moved).toBe(changes.length);
  expect(storedIds("notes")).toEqual(["n-edge"]);
  expect(storedIds("tasks")).toContain("t-list");
});
