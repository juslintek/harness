import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import type { RunRow } from "../runtimes/api";
import { recordRunStack } from "./stack";

function git(cwd: string, ...args: string[]): void {
  const res = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString());
}

test("recordRunStack reads the worktree even when GIT_DIR points elsewhere", async () => {
  const repo = mkdtempSync(join(tmpdir(), "stack-"));
  git(repo, "init", "-q", "-b", "main");
  git(
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "i",
  );
  writeFileSync(join(repo, "composer.json"), '{"require":{"laravel/framework":"11"}}');
  const db = openDb(":memory:");
  migrate(db, migrations);
  const run = { id: "r1", repo, worktree: repo } as RunRow;
  process.env.GIT_DIR = mkdtempSync(join(tmpdir(), "decoy-"));
  try {
    await recordRunStack(db, run);
  } finally {
    delete process.env.GIT_DIR;
  }
  const items = db.query("SELECT item FROM run_stack ORDER BY item").all();
  expect(items).toEqual([{ item: "laravel/framework" }, { item: "php" }]);
});
