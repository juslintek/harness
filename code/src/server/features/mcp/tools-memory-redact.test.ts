import "../../test-support/no-git-env";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { startStub, stopStubs } from "../../test-support/stub-server";
import { resetLayaCircuit } from "../laya/api";
import { startMemory } from "../memory/api";
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

test("an unscoped create never sends the secret to Laya", async () => {
  const sent: string[] = [];
  const stub = await startStub(async (req) => {
    sent.push(await req.text());
    return Response.json({ model: "laya:en", answers: {} });
  });
  process.env.OLLAYA_URL = stub.url;
  resetLayaCircuit();
  try {
    const dev = w.agent(w.a.id, "dev");
    const key = "AKIAIOSFODNN7EXAMPLE";
    const made = await call(server, tokenOf(dev.id, w.a.id), "memory", {
      action: "create",
      path: "/memories/keys.md",
      file_text: `# Keys\nuse ${key} for the deploy`,
    });
    expect(made.isError).toBe(false);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.join("")).not.toContain(key);
  } finally {
    delete process.env.OLLAYA_URL;
    await stopStubs();
  }
});
