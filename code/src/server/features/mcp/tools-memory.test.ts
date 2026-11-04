import "../../test-support/no-git-env";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { startStub, stopStubs } from "../../test-support/stub-server";
import { resetLayaCircuit } from "../laya/client";
import {
  agentViewer,
  getIndexedByDisk,
  onMemoryChange,
  revertWrite,
  searchNotes,
  startMemory,
} from "../memory/api";
import { grantProject } from "../orgs/api";
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

const SCOPES = ["report", "guard_hook", "memory"] as const;
const tokenOf = (memberId: string, orgId: string): string =>
  tokenFor(db, memberId, orgId, [...SCOPES]);

test("view lists a nested folder, and says not found when it holds nothing", async () => {
  const dev = w.agent(w.a.id, "dev");
  const mem = (args: Record<string, unknown>) =>
    call(server, tokenOf(dev.id, w.a.id), "memory", args);
  await mem({
    action: "create",
    path: "/memories/org/howto/deploy.md",
    file_text: "# Deploy\nship",
  });
  await mem({ action: "create", path: "/memories/org/other.md", file_text: "# Other\nx" });
  const listed = await mem({ action: "view", path: "/memories/org/howto" });
  expect(listed.text).toContain("/memories/org/howto/deploy.md");
  expect(listed.text).not.toContain("other.md");
  const empty = await mem({ action: "view", path: "/memories/org/nothing/here" });
  expect(empty.isError).toBe(true);
  expect(empty.text).toBe("not found");
});

test("create, view, str_replace, insert, rename and delete round trip", async () => {
  const dev = w.agent(w.a.id, "dev");
  const t = tokenOf(dev.id, w.a.id);
  const mem = (args: Record<string, unknown>) => call(server, t, "memory", args);
  const path = "/memories/project/web/deploy.md";
  expect((await mem({ action: "create", path, file_text: "# Deploy\nrun make ship\n" })).text).toBe(
    `created ${path}`,
  );
  const shown = await mem({ action: "view", path });
  expect(shown.text).toBe("     1\t# Deploy\n     2\trun make ship\n     3\t");
  expect((await mem({ action: "view", path, view_range: [2, 2] })).text).toBe(
    "     2\trun make ship",
  );
  expect(
    (await mem({ action: "str_replace", path, old_str: "make ship", new_str: "make $& ship" }))
      .isError,
  ).toBe(false);
  expect((await mem({ action: "view", path, view_range: [2, 2] })).text).toContain("make $& ship");
  await mem({ action: "insert", path, insert_line: 0, insert_text: "first" });
  expect((await mem({ action: "view", path, view_range: [1, 2] })).text).toBe(
    "     1\tfirst\n     2\t# Deploy",
  );
  const moved = "/memories/project/web/ship.md";
  expect((await mem({ action: "rename", old_path: path, new_path: moved })).text).toBe(
    `renamed ${path} to ${moved}`,
  );
  expect((await mem({ action: "view", path })).isError).toBe(true);
  expect((await mem({ action: "view", path: "/memories/project/web" })).text).toContain(moved);
  expect((await mem({ action: "delete", path: moved })).text).toBe(`deleted ${moved}`);
  expect((await mem({ action: "view", path: moved })).text).toBe("note not found");
});

test("search and backlinks list readable paths and log reads with the run", async () => {
  const dev = w.agent(w.a.id, "dev");
  const t = tokenOf(dev.id, w.a.id);
  const mem = (args: Record<string, unknown>) => call(server, t, "memory", args);
  await mem({
    action: "create",
    path: "/memories/org/rollout.md",
    file_text: "# Rollout\nstaging first",
  });
  await mem({
    action: "create",
    path: "/memories/org/plan.md",
    file_text: "# Plan\nsee [[rollout]]",
  });
  const hit = await mem({ action: "search", query: "staging" });
  expect(hit.text).toMatch(/^\/memories\/org\/rollout\.md — Rollout — .*\[staging\]/);
  expect((await mem({ action: "backlinks", path: "/memories/org/rollout.md" })).text).toBe(
    "/memories/org/plan.md — Plan",
  );
  await mem({ action: "view", path: "/memories/org/plan.md" });
  const reads = db
    .query<{ via: string; run_id: string | null }, []>(
      "SELECT via, run_id FROM note_reads ORDER BY at",
    )
    .all();
  expect(reads.map((r) => r.via).sort()).toEqual(["search", "view"]);
  expect(reads.every((r) => r.run_id !== null)).toBe(true);
});

test("str_replace reports a missing and an ambiguous match, and a stale write says to view again", async () => {
  const dev = w.agent(w.a.id, "dev");
  const t = tokenOf(dev.id, w.a.id);
  const mem = (args: Record<string, unknown>) => call(server, t, "memory", args);
  const path = "/memories/agent/n.md";
  await mem({ action: "create", path, file_text: "ab ab" });
  expect(await mem({ action: "str_replace", path, old_str: "zz", new_str: "x" })).toEqual({
    isError: true,
    text: "old_str not found in the note",
  });
  expect((await mem({ action: "str_replace", path, old_str: "ab", new_str: "x" })).text).toBe(
    "old_str appears 2 times, make it unique",
  );
  expect((await mem({ action: "insert", path, insert_line: 9, insert_text: "x" })).isError).toBe(
    true,
  );
});

test("a secret in a write is redacted and the result says so", async () => {
  const dev = w.agent(w.a.id, "dev");
  const t = tokenOf(dev.id, w.a.id);
  const key = `sk-ant-${"a1b2c3d4e5f6g7h8i9j0".repeat(2)}`;
  const res = await call(server, t, "memory", {
    action: "create",
    path: "/memories/agent/k.md",
    file_text: `key ${key}`,
  });
  expect(res.text).toEndWith("Note: secrets were redacted before saving.");
  const view = await call(server, t, "memory", { action: "view", path: "/memories/agent/k.md" });
  expect(view.text).not.toContain(key);
});

test("traversal, odd paths, global writes and the memory root are refused", async () => {
  const dev = w.agent(w.a.id, "dev");
  const t = tokenOf(dev.id, w.a.id);
  const mem = (args: Record<string, unknown>) => call(server, t, "memory", args);
  for (const path of [
    "/memories/../etc/passwd",
    "/memories/agent/../../x.md",
    "/memories/agent/.git/config",
    "/memories/agent/a\\b.md",
    "/etc/passwd",
    "memories/agent/x.md",
  ]) {
    expect(await mem({ action: "view", path })).toEqual({ isError: true, text: "invalid path" });
    expect((await mem({ action: "create", path, file_text: "x" })).isError).toBe(true);
  }
  expect((await mem({ action: "view", path: `/memories/orgs/${w.b.id}/org/x.md` })).isError).toBe(
    true,
  );
  expect(await mem({ action: "create", path: "/memories/global/x.md", file_text: "x" })).toEqual({
    isError: true,
    text: "you are not allowed to do that here",
  });
  expect((await mem({ action: "view", path: "/memories" })).text).toContain("/memories/agent/");
});

test("a path without a scope lands in the agent scope when the run has no project", async () => {
  const dev = w.agent(w.a.id, "dev");
  const t = tokenOf(dev.id, w.a.id);
  const res = await call(server, t, "memory", {
    action: "create",
    path: "/memories/loose.md",
    file_text: "hello",
  });
  expect(res.text).toBe("created /memories/agent/loose.md");
});

test("a token without the memory scope is refused", async () => {
  const dev = w.agent(w.a.id, "dev");
  const t = tokenFor(db, dev.id, w.a.id, ["report", "guard_hook", "board"]);
  expect(await call(server, t, "memory", { action: "view", path: "/memories" })).toEqual({
    isError: true,
    text: "token lacks memory scope",
  });
});

test("an agent of another org cannot view, search, write or revert this org's notes", async () => {
  const alice = w.agent(w.a.id, "alice");
  const bob = w.agent(w.b.id, "bob");
  grantProject(db, w.project.id, w.b.id, "write", alice.id);
  const ta = tokenOf(alice.id, w.a.id);
  const tb = tokenOf(bob.id, w.b.id);
  const secret = "launch codename Falcon";
  for (const path of ["/memories/org/plan.md", "/memories/project/web/plan.md"]) {
    await call(server, ta, "memory", { action: "create", path, file_text: secret });
  }
  const onDisk = (org: string, rest: string): string => `orgs/${org}/${rest}`;
  const aNote = getIndexedByDisk(db, onDisk(w.a.id, "org/plan.md"));
  const changes: string[] = [];
  const off = onMemoryChange((e) => changes.push(`${e.orgId}`));
  const mem = (args: Record<string, unknown>) => call(server, tb, "memory", args);
  for (const path of ["/memories/org/plan.md", "/memories/project/web/plan.md"]) {
    expect(await mem({ action: "view", path })).toEqual({ isError: true, text: "note not found" });
    expect(
      (await mem({ action: "str_replace", path, old_str: "Falcon", new_str: "X" })).isError,
    ).toBe(true);
    expect((await mem({ action: "delete", path })).isError).toBe(true);
    expect((await mem({ action: "backlinks", path })).isError).toBe(true);
    expect(
      (await mem({ action: "rename", old_path: path, new_path: "/memories/org/z.md" })).isError,
    ).toBe(true);
  }
  expect((await mem({ action: "search", query: "Falcon" })).text).toBe("no matches");
  expect((await mem({ action: "view", path: "/memories/project" })).text).not.toContain("plan");
  // Bob writing to the same virtual path creates his own note and leaves Alice's alone.
  await mem({ action: "create", path: "/memories/org/plan.md", file_text: "bob's own" });
  off();
  expect(changes).toEqual([w.b.id]);
  expect(getIndexedByDisk(db, onDisk(w.b.id, "org/plan.md"))?.id).not.toBe(aNote?.id);
  const alicesView = await call(server, ta, "memory", {
    action: "view",
    path: "/memories/org/plan.md",
  });
  expect(alicesView.text).toContain(secret);
  const write = db
    .query<{ id: string }, [string]>("SELECT id FROM note_writes WHERE org_id = ?")
    .get(w.a.id);
  expect(() =>
    revertWrite(db, home, { viewer: agentViewer(db, bob.id), runId: null }, write?.id as string),
  ).toThrow();
  expect(searchNotes(db, agentViewer(db, bob.id), { text: "Falcon" })).toEqual([]);
  expect(existsSync(join(home, "memory", onDisk(w.a.id, "org/plan.md")))).toBe(true);
});

test("access is rebuilt on every call: a removed member loses the tool at once", async () => {
  const dev = w.agent(w.a.id, "dev");
  const t = tokenOf(dev.id, w.a.id);
  const path = "/memories/agent/n.md";
  expect(
    (await call(server, t, "memory", { action: "create", path, file_text: "x" })).isError,
  ).toBe(false);
  db.run("UPDATE members SET org_id = ? WHERE id = ?", [w.b.id, dev.id]);
  expect(await call(server, t, "memory", { action: "view", path })).toEqual({
    isError: true,
    text: "token does not match the member's org",
  });
});

// Guard L1 auto-allows harness tools only when the ACP action carries no `command`, and Codex copies
// rawInput.command into it, so the discriminator must not be called `command`.
test("the memory tool's input schema has no command property", async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/`), {
      requestInit: {
        headers: { authorization: `Bearer ${tokenOf(w.agent(w.a.id, "dev").id, w.a.id)}` },
      },
    }),
  );
  const { tools } = await client.listTools();
  await client.close();
  const props = tools.find((t) => t.name === "memory")?.inputSchema.properties ?? {};
  expect(Object.keys(props)).toContain("action");
  expect(props).not.toHaveProperty("command");
});

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
