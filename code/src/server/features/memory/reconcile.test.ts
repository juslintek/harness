import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startMemory } from "./api";
import { drainCommits } from "./git-log";
import { listWrites } from "./index-log";
import { getIndexedByDisk, upsertIndexed } from "./index-repo";
import { loc, noteText, testDb } from "./index-test-kit";
import { reconcile } from "./reconcile";

let db: Database;
let dir: string;
beforeEach(() => {
  ({ db, dir } = testDb());
});
afterEach(async () => {
  await drainCommits();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function put(rel: string, text: string): void {
  const file = join(dir, "memory", rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

test("indexes files written outside, skips unchanged, drops deleted", () => {
  put("orgs/A/org/a.md", noteText("# A\nhello"));
  put("global/g.md", "plain text");
  expect(reconcile(db, dir)).toEqual({ indexed: 2, removed: 0 });
  expect(reconcile(db, dir)).toEqual({ indexed: 0, removed: 0 });
  put("orgs/A/org/a.md", noteText("# A\nchanged"));
  expect(reconcile(db, dir)).toEqual({ indexed: 1, removed: 0 });
  rmSync(join(dir, "memory/global/g.md"));
  expect(reconcile(db, dir)).toEqual({ indexed: 0, removed: 1 });
  expect(getIndexedByDisk(db, "global/g.md")).toBeNull();
});

test("rows whose file is gone are removed even when the vault is missing", () => {
  upsertIndexed(db, loc("global/g.md"), noteText("x"));
  expect(reconcile(db, dir)).toEqual({ indexed: 0, removed: 1 });
});

test("never indexes symlinks, .git or files outside memory", () => {
  put("global/real.md", "real");
  put("global/.git/hidden.md", "no");
  put("orgs/A/org/ok.md", "ok");
  writeFileSync(join(dir, "outside.md"), "outside");
  mkdirSync(join(dir, "elsewhere"));
  writeFileSync(join(dir, "elsewhere/leak.md"), "leak");
  symlinkSync(join(dir, "outside.md"), join(dir, "memory/global/link.md"));
  symlinkSync(join(dir, "elsewhere"), join(dir, "memory/orgs/A/org/linked"));
  expect(reconcile(db, dir)).toEqual({ indexed: 2, removed: 0 });
  const disks = db.query<{ disk: string }, []>("SELECT disk FROM notes ORDER BY disk").all();
  expect(disks.map((d) => d.disk)).toEqual(["global/real.md", "orgs/A/org/ok.md"]);
});

test("ignores org dirs the instance does not know", () => {
  put("orgs/ghost/org/a.md", "x");
  expect(reconcile(db, dir)).toEqual({ indexed: 0, removed: 0 });
});

test("a symlinked vault root throws instead of emptying the index", () => {
  put("global/kept.md", "x");
  reconcile(db, dir);
  rmSync(join(dir, "memory"), { recursive: true });
  mkdirSync(join(dir, "real/global"), { recursive: true });
  writeFileSync(join(dir, "real/global/a.md"), "x");
  symlinkSync(join(dir, "real"), join(dir, "memory"));
  expect(() => reconcile(db, dir)).toThrow(/plain directory/);
  expect(db.query("SELECT 1 FROM notes").all()).toHaveLength(1);
});

test("a read error throws and leaves the index intact", () => {
  put("global/a.md", "x");
  put("global/sub/b.md", "y");
  reconcile(db, dir);
  const sub = join(dir, "memory/global/sub");
  chmodSync(sub, 0o000);
  try {
    expect(() => reconcile(db, dir)).toThrow();
  } finally {
    chmodSync(sub, 0o700);
  }
  expect(db.query("SELECT 1 FROM notes").all()).toHaveLength(2);
});

test("an indexed note that became unreadable is dropped with an audit row", () => {
  put("orgs/A/org/a.md", noteText("# A\nhello"));
  reconcile(db, dir);
  const file = join(dir, "memory/orgs/A/org/a.md");
  chmodSync(file, 0o000);
  try {
    reconcile(db, dir);
  } finally {
    chmodSync(file, 0o600);
  }
  expect(getIndexedByDisk(db, "orgs/A/org/a.md")).toBeNull();
  const [last] = listWrites(db, "A", { limit: 5 });
  expect(last).toMatchObject({ op: "outside", actor: "outside" });
});

test("a missing vault root is an empty vault", () => {
  expect(reconcile(db, dir)).toEqual({ indexed: 0, removed: 0 });
});

test("a row whose file is gone leaves an outside delete audit row", () => {
  put("orgs/A/org/a.md", noteText("# A\nhello"));
  reconcile(db, dir);
  rmSync(join(dir, "memory/orgs/A/org/a.md"));
  expect(reconcile(db, dir)).toEqual({ indexed: 0, removed: 1 });
  const [last] = listWrites(db, "A", { limit: 5 });
  expect(last).toMatchObject({ op: "outside", actor: "outside" });
  expect(last?.afterHash).toBeNull();
});

test("one file that cannot be indexed is skipped and startMemory still starts", async () => {
  put("orgs/A/org/bad.md", noteText("# Bad\nkey AKIAIOSFODNN7EXAMPLE"));
  put("orgs/A/org/good.md", noteText("# Good\nfine"));
  db.run(`CREATE TRIGGER refuse BEFORE INSERT ON notes WHEN NEW.disk = 'orgs/A/org/bad.md'
          BEGIN SELECT RAISE(ABORT, 'refused'); END`);
  expect(reconcile(db, dir)).toEqual({ indexed: 1, removed: 0 });
  expect(getIndexedByDisk(db, "orgs/A/org/good.md")).not.toBeNull();
  const stop = startMemory(db, { home: dir });
  await stop();
});
