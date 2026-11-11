import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { branchWith, makeRepo } from "../../test-support/selfupdate-kit";
import { changedFiles, diffStat, parseNameStatus } from "./diff";
import { resolveCommit } from "./steps";

test("parses modify, delete and rename records", () => {
  expect(parseNameStatus("M\0a.ts\0D\0b.ts\0R087\0old.ts\0new.ts\0")).toEqual([
    { status: "M", path: "a.ts" },
    { status: "D", path: "b.ts" },
    { status: "R087", path: "new.ts", oldPath: "old.ts" },
  ]);
  expect(parseNameStatus("")).toEqual([]);
  expect(() => parseNameStatus("R100\0only-one\0")).toThrow();
});

const ODD = ["with space.ts", "line\nbreak.ts", 'quote"q.ts', "ünï.ts", " lead.ts"];

test("reads names with spaces, newlines and quotes from a real repo, renames included", async () => {
  const repo = await makeRepo("1.0.0");
  mkdirSync(join(repo, "code/src"), { recursive: true });
  writeFileSync(join(repo, "code/src/moved.ts"), "export const moved = 'a long enough body';\n");
  Bun.spawnSync(["git", "add", "-A"], { cwd: repo });
  Bun.spawnSync(["git", "commit", "-q", "-m", "seed"], { cwd: repo });
  const files = Object.fromEntries(ODD.map((name) => [`code/src/${name}`, name]));
  await branchWith(repo, "feature", files);
  Bun.spawnSync(["git", "checkout", "-q", "feature"], { cwd: repo });
  Bun.spawnSync(["git", "mv", "code/src/moved.ts", "code/src/line\nmoved.ts"], { cwd: repo });
  Bun.spawnSync(["git", "commit", "-q", "-m", "mv"], { cwd: repo });
  Bun.spawnSync(["git", "checkout", "-q", "main"], { cwd: repo });
  const sha = await resolveCommit(repo, "feature");
  const base = await resolveCommit(repo, "main");
  const changes = await changedFiles(repo, base, sha);
  expect(changes.map((c) => c.path).sort()).toEqual(
    [...ODD.map((n) => `code/src/${n}`), "code/src/line\nmoved.ts"].sort(),
  );
  expect(changes.find((c) => c.status.startsWith("R"))?.oldPath).toBe("code/src/moved.ts");
  expect(await diffStat(repo, base, sha)).toContain("files changed");
});

test("diffs against the given running commit, not the default branch", async () => {
  const repo = await makeRepo("1.0.0");
  const running = await resolveCommit(repo, "main");
  await branchWith(repo, "later", { "code/src/server/features/guard/x.ts": "export {};\n" });
  Bun.spawnSync(["git", "merge", "-q", "--ff-only", "later"], { cwd: repo });
  const sha = await resolveCommit(repo, "main");
  expect((await changedFiles(repo, running, sha)).map((c) => c.path)).toEqual([
    "code/src/server/features/guard/x.ts",
  ]);
  expect(await changedFiles(repo, sha, sha)).toEqual([]);
});
