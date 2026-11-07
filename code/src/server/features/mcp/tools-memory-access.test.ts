import "../../test-support/no-git-env";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { startMemory } from "../memory/api";
import { reconcile } from "../memory/reconcile";
import { vaultDir, writeNoteFileAtomic } from "../memory/vault";
import { call, type Db, listen, tokenFor, type World, world } from "./test-kit";

let db: Db;
let home: string;
let stop: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
let w: World;

beforeEach(async () => {
  db = openDb(":memory:");
  migrate(db, migrations);
  home = mkdtempSync(join(tmpdir(), "harness-memtool-"));
  stop = startMemory(db, { home });
  server = await listen(db, home);
  w = world(db);
});
afterEach(async () => {
  server.stop(true);
  await stop();
  rmSync(home, { recursive: true, force: true });
});

const tokenOf = (memberId: string, orgId: string): string =>
  tokenFor(db, memberId, orgId, ["report", "guard_hook", "memory"]);

test("a viewer-role agent reads memory but every write is forbidden", async () => {
  const dev = w.agent(w.a.id, "dev");
  const mem = (args: Record<string, unknown>) =>
    call(server, tokenOf(dev.id, w.a.id), "memory", args);
  await mem({ action: "create", path: "/memories/org/a.md", file_text: "# A\nx" });
  db.run("UPDATE members SET role = 'viewer' WHERE id = ?", [dev.id]);
  const denied = await mem({ action: "create", path: "/memories/agent/b.md", file_text: "# B" });
  expect(denied).toEqual({ isError: true, text: "you are not allowed to do that here" });
  expect((await mem({ action: "delete", path: "/memories/org/a.md" })).isError).toBe(true);
  expect((await mem({ action: "view", path: "/memories/org/a.md" })).text).toContain("# A");
});

test("view lists an old nested folder under newer notes, and matches the folder name literally", async () => {
  const dev = w.agent(w.a.id, "dev");
  const mem = (args: Record<string, unknown>) =>
    call(server, tokenOf(dev.id, w.a.id), "memory", args);
  await stop();
  stop = async () => {};
  const orgDir = join(vaultDir(home), "orgs", w.a.id, "org");
  mkdirSync(orgDir, { recursive: true, mode: 0o700 });
  const oldTime = Date.now() - 200_000;
  const writeNote = (disk: string, title: string, updated: number): void => {
    const time = JSON.stringify(new Date(updated).toISOString());
    writeNoteFileAtomic(home, disk, `---\nupdated: ${time}\n---\n\n# ${title}\nx\n`, null);
  };
  writeNote(`orgs/${w.a.id}/org/old_dir/n.md`, "Old", oldTime);
  writeNote(`orgs/${w.a.id}/org/oldxdir/m.md`, "Other", oldTime);
  for (let i = 0; i < 101; i++) {
    writeNote(`orgs/${w.a.id}/org/new${i}.md`, `New ${i}`, oldTime + (i + 1) * 1_000);
  }
  reconcile(db, home);
  const listed = await mem({ action: "view", path: "/memories/org/old_dir" });
  expect(listed.isError).toBe(false);
  expect(listed.text).toContain("/memories/org/old_dir/n.md");
  expect(listed.text).not.toContain("oldxdir");
});
