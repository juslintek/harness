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
  const changes = await changedFiles(repo, sha);
  expect(changes.map((c) => c.path).sort()).toEqual(
    [...ODD.map((n) => `code/src/${n}`), "code/src/line\nmoved.ts"].sort(),
  );
  expect(changes.find((c) => c.status.startsWith("R"))?.oldPath).toBe("code/src/moved.ts");
  expect(await diffStat(repo, sha)).toContain("files changed");
});
