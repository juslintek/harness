import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { buildMemoryIndex } from "./index-file";
import { upsertIndexed } from "./index-repo";
import { loc, noteText, testDb, viewer } from "./index-test-kit";

let env: ReturnType<typeof testDb>;
beforeEach(() => {
  env = testDb();
});
afterEach(() => {
  env.db.close();
  rmSync(env.dir, { recursive: true, force: true });
});

const add = (disk: string, body: string, updated?: string): void => {
  upsertIndexed(env.db, loc(disk), noteText(body, updated === undefined ? {} : { updated }));
};
const alice = viewer("A", "m1", ["pa"]);

test("each scope gets a heading and each note its title, virtual path and body", () => {
  add("orgs/A/org/deploy.md", "# Deploy\nrun the script");
  add("orgs/A/projects/pa/api.md", "# API\nuse v2");
  add("orgs/A/agents/m1/mine.md", "# Mine\nprefer small diffs");
  const text = buildMemoryIndex(env.db, alice, null, "");
  expect(text).toContain(
    "# Org notes\n\n## Deploy\n/memories/org/deploy.md\n\n# Deploy\nrun the script",
  );
  expect(text).toContain("## API\n/memories/project/pa/api.md");
  expect(text).toContain("## Mine\n/memories/agent/mine.md");
  expect(text.indexOf("# Your notes")).toBeLessThan(text.indexOf("# Project notes"));
});

test("a note matching the task comes first, the rest follow newest first", () => {
  add("orgs/A/org/old.md", "# Old\nnothing relevant", "2020-01-01T00:00:00Z");
  add("orgs/A/org/new.md", "# New\nnothing relevant", "2024-01-01T00:00:00Z");
  add("orgs/A/org/hit.md", "# Hit\nrollback procedure", "2019-01-01T00:00:00Z");
  const text = buildMemoryIndex(env.db, alice, null, "how to rollback");
  const at = (t: string): number => text.indexOf(`## ${t}`);
  expect(at("Hit")).toBeLessThan(at("New"));
  expect(at("New")).toBeLessThan(at("Old"));
});

test("notes of another org never appear", () => {
  add("orgs/B/org/theirs.md", "# Theirs\ncross-org-secret");
  add("orgs/B/projects/pa/theirs2.md", "# Theirs2\ncross-org-secret");
  add("orgs/A/org/ours.md", "# Ours\nfine");
  const text = buildMemoryIndex(env.db, alice, null, "cross-org-secret");
  expect(text).not.toContain("cross-org-secret");
  expect(text).toContain("## Ours");
});

test("the index stops at a note boundary under 32 KB and logs a read per included note", () => {
  const chunk = "x".repeat(10_000);
  for (const n of ["a", "b", "c", "d"]) add(`orgs/A/org/${n}.md`, `# ${n}\n${chunk}`);
  const text = buildMemoryIndex(env.db, alice, null, "");
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32 * 1024);
  const included = text.match(/^## /gm)?.length ?? 0;
  expect(included).toBe(3);
  const reads = env.db
    .query<{ via: string; run_id: string | null; member_id: string | null }, []>(
      "SELECT via, run_id, member_id FROM note_reads",
    )
    .all();
  expect(reads).toHaveLength(3);
  expect(reads.every((r) => r.via === "index" && r.run_id === null && r.member_id === "m1")).toBe(
    true,
  );
});

test("nothing visible gives an empty index", () => {
  expect(buildMemoryIndex(env.db, alice, null, "anything")).toBe("");
});

test("project lessons lead the index even when the task text matches nothing in them", () => {
  env.db.run(
    "INSERT INTO projects (id, org_id, key, name, created_at) VALUES ('pa', 'A', 'pa', 'Pa', 1)",
  );
  upsertIndexed(
    env.db,
    loc("orgs/A/projects/pa/rule.md"),
    noteText("# Header rule\nbegin files with an owner line", { type: "lesson" }),
  );
  add("orgs/A/agents/m1/mine.md", "# Mine\nclamp helper tips");
  const text = buildMemoryIndex(env.db, alice, "pa", "clamp helper");
  expect(
    text.startsWith("# Project and org lessons\n\n## Header rule\n/memories/project/pa/rule.md"),
  ).toBe(true);
  expect(text.indexOf("# Your notes")).toBeGreaterThan(text.indexOf("# Project and org lessons"));
});

test("a note too big for the budget is skipped and smaller notes after it still fit", () => {
  add("orgs/A/org/huge.md", `# huge\n${"x".repeat(40_000)}`, "2026-02-01T00:00:00.000Z");
  add("orgs/A/org/small.md", "# small\nfits", "2026-01-01T00:00:00.000Z");
  const text = buildMemoryIndex(env.db, alice, null, "");
  expect(text).toContain("## small");
  expect(text).not.toContain("## huge");
});

test("an old lesson still reaches the index behind more than 100 newer notes", () => {
  add("orgs/A/org/rule.md", "# Rule\nalways rebase", "2018-01-01T00:00:00Z");
  env.db.run("UPDATE notes SET type = 'lesson' WHERE disk = 'orgs/A/org/rule.md'");
  for (let i = 0; i < 105; i++)
    add(`orgs/A/org/n${i}.md`, `# N${i}\nfiller`, "2024-01-01T00:00:00Z");
  const text = buildMemoryIndex(env.db, alice, null, "unrelated words");
  expect(text).toContain("# Project and org lessons\n\n## Rule");
});

test("project notes of another project cannot crowd the run's own note out of the cap", () => {
  const other = viewer("A", "m1", ["pa", "pb"]);
  for (const key of ["pa", "pb"]) {
    env.db.run(
      "INSERT INTO projects (id, org_id, key, name, created_at) VALUES (?, 'A', ?, ?, 1)",
      [key, key, key],
    );
  }
  add("orgs/A/projects/pa/mine.md", "# Mine\nold but relevant", "2019-01-01T00:00:00Z");
  for (let i = 0; i < 120; i++) {
    add(`orgs/A/projects/pb/n${i}.md`, `# N${i}\nfiller`, "2024-01-01T00:00:00Z");
  }
  expect(buildMemoryIndex(env.db, other, "pa", "")).toContain("## Mine");
});
