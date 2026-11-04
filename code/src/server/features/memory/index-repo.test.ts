import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { getWrite, listWrites, logRead, logWrite } from "./index-log";
import { getIndexed, getIndexedByDisk, removeIndexed, upsertIndexed } from "./index-repo";
import { backlinks, facets, resolveWikilink, searchNotes } from "./index-search";
import { loc, noteText, testDb, viewer } from "./index-test-kit";

let db: Database;
let dir: string;
beforeEach(() => {
  ({ db, dir } = testDb());
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const A_ORG = "orgs/A/org/deploy.md";
const A_PROJ = "orgs/A/projects/pa/plan.md";
const A_AGENT = "orgs/A/agents/m1/mine.md";
const A_OTHER = "orgs/A/agents/m2/theirs.md";
const GLOBAL = "global/shared.md";

function seed(): void {
  upsertIndexed(db, loc(A_ORG), noteText("# Deploy\nrollback needle steps"));
  upsertIndexed(db, loc(A_PROJ), noteText("# Plan\nneedle for project"));
  upsertIndexed(db, loc(A_AGENT), noteText("# Mine\nneedle private", { tags: ["x"] }));
  upsertIndexed(db, loc(A_OTHER), noteText("# Theirs\nneedle of m2"));
  upsertIndexed(db, loc(GLOBAL), noteText("# Shared\nneedle global"));
}

test("upsert then search finds the note with a snippet and defaults", () => {
  const n = upsertIndexed(db, loc(A_ORG), "# Deploy\nrollback the needle");
  expect(n.type).toBe("fact");
  expect(n.id.length).toBeGreaterThan(10);
  const hits = searchNotes(db, viewer("A", null, []), { text: "needle" });
  expect(hits.map((h) => h.id)).toEqual([n.id]);
  expect(hits[0]?.snippet).toContain("[needle]");
  expect(getIndexed(db, n.id)?.disk).toBe(A_ORG);
  expect(searchNotes(db, viewer("A", null, []), { text: "rollbacks" })).toHaveLength(1);
});

test("org B viewer never sees org A notes, for every scope filter", () => {
  seed();
  const b = viewer("B", "mB", ["pa"]);
  for (const scope of [undefined, "org", "project", "agent", "global"] as const) {
    const hits = searchNotes(db, b, { text: "needle", ...(scope ? { scope } : {}) });
    expect(hits.every((h) => h.scope === "global")).toBe(true);
    const none = searchNotes(db, b, { ...(scope ? { scope } : {}), projectId: "pa" });
    expect(none).toHaveLength(0);
  }
  expect(facets(db, b).scopes).toEqual({ global: 1 });
  const orgNote = getIndexedByDisk(db, A_ORG);
  expect(backlinks(db, b, orgNote?.id as string)).toEqual([]);
  expect(resolveWikilink(db, b, "deploy", GLOBAL)).toBeNull();
  expect(resolveWikilink(db, b, "plan", GLOBAL)).toBeNull();
});

test("agent viewer sees own agent notes and granted projects only", () => {
  seed();
  const hits = searchNotes(db, viewer("A", "m1", []), { text: "needle" });
  expect(hits.map((h) => h.path).sort()).toEqual([A_AGENT, A_ORG, GLOBAL].sort());
  const human = searchNotes(db, viewer("A", null, ["pa"]), { text: "needle" });
  expect(human).toHaveLength(5);
});

test("filters by type, tag, source agent and project", () => {
  seed();
  const h = viewer("A", null, ["pa"]);
  expect(searchNotes(db, h, { tag: "x" }).map((n) => n.path)).toEqual([A_AGENT]);
  expect(searchNotes(db, h, { projectId: "pa" })).toHaveLength(1);
  expect(searchNotes(db, h, { sourceAgent: "nobody" })).toHaveLength(0);
  expect(searchNotes(db, h, { type: "fact", limit: 2 })).toHaveLength(2);
});

test("hostile fts text does not throw", () => {
  seed();
  const h = viewer("A", null, []);
  expect(() => searchNotes(db, h, { text: 'foo" OR *' })).not.toThrow();
  expect(() => searchNotes(db, h, { text: "NEAR(a b) ^ -" })).not.toThrow();
  expect(searchNotes(db, h, { text: '"*' })).toEqual([]);
});

test("backlinks follow slug or title and respect visibility", () => {
  const target = upsertIndexed(db, loc(A_ORG), noteText("# Deploy\nbody"));
  upsertIndexed(db, loc("orgs/A/org/a.md"), noteText("see [[deploy]]"));
  upsertIndexed(db, loc("orgs/A/org/b.md"), noteText("see [[Deploy|x]]"));
  upsertIndexed(db, loc(A_OTHER), noteText("hidden [[deploy]]"));
  const links = backlinks(db, viewer("A", "m1", []), target.id);
  expect(links.map((l) => l.path).sort()).toEqual(["orgs/A/org/a.md", "orgs/A/org/b.md"]);
  expect(backlinks(db, viewer("A", "m2", []), target.id)).toHaveLength(3);
});

test("resolveWikilink prefers same directory, then narrower scope", () => {
  upsertIndexed(db, loc("global/topic.md"), noteText("g"));
  upsertIndexed(db, loc("orgs/A/org/topic.md"), noteText("o"));
  upsertIndexed(db, loc("orgs/A/agents/m1/topic.md"), noteText("a"));
  const v = viewer("A", "m1", []);
  expect(resolveWikilink(db, v, "Topic", "orgs/A/org/x.md")?.disk).toBe("orgs/A/org/topic.md");
  expect(resolveWikilink(db, v, "topic", "orgs/A/projects/p/x.md")?.disk).toBe(
    "orgs/A/agents/m1/topic.md",
  );
  expect(resolveWikilink(db, v, "missing", GLOBAL)).toBeNull();
});

test("facets count visible notes", () => {
  seed();
  const f = facets(db, viewer("A", "m1", ["pa"]));
  expect(f.scopes).toEqual({ global: 1, org: 1, project: 1, agent: 1 });
  expect(f.tags).toEqual({ x: 1 });
  expect(f.sources).toEqual({ bot: 4 });
  expect(f.types).toEqual({ fact: 4 });
});

test("duplicate id: the newer file keeps it, the older gets a fresh id", () => {
  upsertIndexed(
    db,
    loc("orgs/A/org/old.md"),
    noteText("old", { id: "dup", updated: "2024-01-01T00:00:00Z" }),
  );
  upsertIndexed(
    db,
    loc("orgs/A/org/new.md"),
    noteText("new", { id: "dup", updated: "2025-01-01T00:00:00Z" }),
  );
  expect(getIndexedByDisk(db, "orgs/A/org/new.md")?.id).toBe("dup");
  const moved = getIndexedByDisk(db, "orgs/A/org/old.md");
  expect(moved?.id).not.toBe("dup");
  const loser = upsertIndexed(
    db,
    loc("orgs/A/org/older.md"),
    noteText("o", { id: "dup", updated: "2020-01-01T00:00:00Z" }),
  );
  expect(loser.id).not.toBe("dup");
  expect(getIndexed(db, "dup")?.disk).toBe("orgs/A/org/new.md");
});

test("removeIndexed drops note, links and fts row", () => {
  const n = upsertIndexed(db, loc(A_ORG), noteText("needle [[x]]"));
  expect(removeIndexed(db, A_ORG)).toBe(n.id);
  expect(removeIndexed(db, A_ORG)).toBeNull();
  expect(searchNotes(db, viewer("A", null, []), { text: "needle" })).toEqual([]);
  expect(db.query("SELECT 1 FROM note_links").all()).toEqual([]);
});

test("write and read logs round trip", () => {
  const w = {
    noteId: "n",
    disk: A_ORG,
    orgId: "A",
    op: "update" as const,
    actor: "bot",
    memberId: "m1",
    runId: "r1",
    beforeText: "a",
    afterText: "b",
    beforeHash: "h1",
    afterHash: "h2",
  };
  const id = logWrite(db, w);
  logWrite(db, { ...w, runId: null, memberId: null, actor: "human:u" });
  logWrite(db, { ...w, orgId: "B" });
  expect(getWrite(db, id)).toMatchObject({ ...w, id });
  expect(listWrites(db, "A", { limit: 10 })).toHaveLength(2);
  expect(listWrites(db, "A", { limit: 10, agentsOnly: true }).map((x) => x.id)).toEqual([id]);
  logRead(db, "n", "r1", "m1", "view");
  expect(db.query("SELECT via FROM note_reads").all()).toEqual([{ via: "view" }]);
});
