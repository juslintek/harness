import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountView } from "../../../shared/accounts";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createApp } from "../../http";
import { isolatedStubSpec } from "../../test-support/agents-kit";
import { sessionHeaders, withActor } from "../../test-support/app-kit";
import { readBody } from "../logs/api";
import { setLinked } from "./api";
import { agentRoutes } from "./routes";

let db: Database;
let home: string;

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db, migrations);
  home = mkdtempSync(join(tmpdir(), "harness-accounts-"));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const noAcp = (): Promise<never> => Promise.reject(new Error("not used"));
const routes = (session?: Parameters<typeof withActor>[1]): ReturnType<typeof withActor> =>
  withActor(
    // A stub spec keeps removal from running a vendor logout on the machine running the tests.
    agentRoutes(db, { listAcp: noAcp }, home, { spec: isolatedStubSpec() }),
    session,
  );

const send = (
  app: ReturnType<typeof withActor>,
  method: string,
  path: string,
  body?: unknown,
): Response | Promise<Response> =>
  app.request(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json" },
  });

async function add(label: string, runtime = "claude"): Promise<AccountView> {
  const res = await send(routes(), "POST", `/${runtime}/accounts`, { label });
  expect(res.status).toBe(201);
  return (await res.json()) as AccountView;
}

const kinds = (): string[] =>
  db
    .query<{ kind: string }, []>(
      "SELECT kind FROM events WHERE kind LIKE 'account.%' ORDER BY rowid",
    )
    .all()
    .map((row) => row.kind);

test("add and remove need a fresh step-up", async () => {
  const stale = routes({ stepUpAt: null });
  const res = await send(stale, "POST", "/claude/accounts", { label: "work" });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "step_up_required" });
  const account = await add("work");
  expect((await send(stale, "DELETE", `/claude/accounts/${account.id}`)).status).toBe(403);
  expect(
    (await send(stale, "PATCH", `/claude/accounts/${account.id}`, { enabled: false })).status,
  ).toBe(403);
});

test("add inserts a pending row and creates a 0700 home named by the id", async () => {
  const account = await add("work");
  expect(account.state).toBe("pending");
  expect(account.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  expect(account.home).toBe(join(home, "accounts", account.id));
  expect(statSync(account.home as string).mode & 0o777).toBe(0o700);
  const listed = await (await send(routes(), "GET", "/claude/accounts")).json();
  expect((listed as AccountView[]).map((a) => a.id)).toContain(account.id);
  expect(kinds()).toEqual(["account.added"]);
});

test("labels that could become paths or are the wrong size are refused", async () => {
  for (const label of ["a/b", "..", "", " ", "x".repeat(65), "a\u0000b", "tab\there"]) {
    const res = await send(routes(), "POST", "/claude/accounts", { label });
    expect(res.status).toBe(400);
  }
  expect((await send(routes(), "POST", "/claude/accounts", { label: "x".repeat(64) })).status).toBe(
    201,
  );
  expect(existsSync(join(home, "accounts"))).toBe(true);
});

test("a duplicate label for one runtime is refused with a clear error, another runtime may reuse it", async () => {
  await add("work");
  const dup = await send(routes(), "POST", "/claude/accounts", { label: "work" });
  expect(dup.status).toBe(409);
  expect(await dup.json()).toEqual({ error: "an account named work already exists for claude" });
  expect((await send(routes(), "POST", "/codex/accounts", { label: "work" })).status).toBe(201);
});

test("unknown runtimes and accounts of another runtime are 404", async () => {
  expect((await send(routes(), "POST", "/nope/accounts", { label: "work" })).status).toBe(404);
  const account = await add("work");
  expect((await send(routes(), "DELETE", `/codex/accounts/${account.id}`)).status).toBe(404);
  expect(
    (await send(routes(), "PATCH", `/claude/accounts/missing`, { enabled: true })).status,
  ).toBe(404);
});

test("disable and enable move the state and append events", async () => {
  const account = await add("work");
  const off = await send(routes(), "PATCH", `/claude/accounts/${account.id}`, { enabled: false });
  expect(((await off.json()) as AccountView).state).toBe("disabled");
  const on = await send(routes(), "PATCH", `/claude/accounts/${account.id}`, { enabled: true });
  expect(((await on.json()) as AccountView).state).toBe("unknown");
  expect(kinds()).toEqual(["account.added", "account.disabled", "account.enabled"]);
  expect(
    (await send(routes(), "PATCH", `/claude/accounts/${account.id}`, { enabled: "yes" })).status,
  ).toBe(400);
});

test("remove refuses the default account", async () => {
  setLinked(db, "claude", true);
  const res = await send(routes(), "DELETE", "/claude/accounts/default:claude");
  expect(res.status).toBe(409);
  expect(db.query("SELECT state FROM agent_accounts WHERE id = 'default:claude'").get()).toEqual({
    state: "unknown",
  });
});

function runOn(accountId: string, state: string): void {
  db.run(
    "INSERT INTO runs (id, agent_id, repo, prompt, state, created_at, account_id) VALUES (?, 'claude', '/r', 'p', ?, 1, ?)",
    [Bun.randomUUIDv7(), state, accountId],
  );
}

test("remove refuses an account with live runs, finished runs do not block", async () => {
  const account = await add("work");
  for (const state of ["running", "starting", "queued"]) {
    db.run("DELETE FROM runs");
    runOn(account.id, state);
    expect((await send(routes(), "DELETE", `/claude/accounts/${account.id}`)).status).toBe(409);
  }
  expect(existsSync(account.home as string)).toBe(true);
  db.run("DELETE FROM runs");
  for (const state of ["completed", "failed", "cancelled", "blocked"]) runOn(account.id, state);
  expect((await send(routes(), "DELETE", `/claude/accounts/${account.id}`)).status).toBe(200);
});

test("?drain=1 sets removing instead of refusing and keeps the home", async () => {
  const account = await add("work");
  runOn(account.id, "running");
  const res = await send(routes(), "DELETE", `/claude/accounts/${account.id}?drain=1`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as AccountView).state).toBe("removing");
  expect(existsSync(account.home as string)).toBe(true);
  expect(kinds()).toEqual(["account.added", "account.removed"]);
});

test("remove deletes the home, keeps the row as removed and audits it", async () => {
  const account = await add("work");
  writeFileSync(join(account.home as string, "marker"), "x");
  const res = await send(routes(), "DELETE", `/claude/accounts/${account.id}`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as AccountView).state).toBe("removed");
  expect(existsSync(account.home as string)).toBe(false);
  expect(db.query("SELECT state FROM agent_accounts WHERE id = ?").get(account.id)).toEqual({
    state: "removed",
  });
  expect(kinds()).toEqual(["account.added", "account.removed"]);
});

test("a symlinked home pointing outside the accounts directory is not followed", async () => {
  const account = await add("work");
  const outside = mkdtempSync(join(tmpdir(), "harness-outside-"));
  writeFileSync(join(outside, "precious"), "keep");
  rmSync(account.home as string, { recursive: true });
  symlinkSync(outside, account.home as string);
  const res = await send(routes(), "DELETE", `/claude/accounts/${account.id}`);
  expect(res.status).toBe(409);
  expect(existsSync(join(outside, "precious"))).toBe(true);
  expect(db.query("SELECT state FROM agent_accounts WHERE id = ?").get(account.id)).toEqual({
    state: "pending",
  });
  rmSync(outside, { recursive: true, force: true });
});

test("a row whose home points outside the accounts directory is never deleted", async () => {
  const account = await add("work");
  const outside = mkdtempSync(join(tmpdir(), "harness-outside-"));
  mkdirSync(join(outside, "inner"));
  db.run("UPDATE agent_accounts SET home = ? WHERE id = ?", [outside, account.id]);
  expect((await send(routes(), "DELETE", `/claude/accounts/${account.id}`)).status).toBe(409);
  expect(existsSync(join(outside, "inner"))).toBe(true);
  rmSync(outside, { recursive: true, force: true });
});

test("a missing home directory does not block removal", async () => {
  const account = await add("work");
  rmSync(account.home as string, { recursive: true });
  expect((await send(routes(), "DELETE", `/claude/accounts/${account.id}`)).status).toBe(200);
});

test("link and unlink append events, and no event carries a path or secret", async () => {
  const app = routes();
  await send(app, "POST", "/codex/link", { enabled: true });
  await send(app, "POST", "/codex/link", { enabled: false });
  const account = await add("work");
  await send(app, "DELETE", `/claude/accounts/${account.id}`);
  expect(kinds()).toEqual([
    "account.linked",
    "account.unlinked",
    "account.added",
    "account.removed",
  ]);
  const rows = db
    .query<{ kind: string; account_id: string | null; rowid: number }, []>(
      "SELECT kind, account_id, rowid FROM events ORDER BY rowid",
    )
    .all();
  expect(rows.map((row) => row.account_id)).toEqual([
    "default:codex",
    "default:codex",
    account.id,
    account.id,
  ]);
  for (const row of rows) {
    const body = readBody(db, row.rowid) ?? "";
    expect(body).not.toContain(home);
    expect(body.replace(account.id, "")).not.toMatch(/[A-Za-z0-9_-]{20,}/);
    expect(body.length).toBeGreaterThan(0);
  }
});

test("through the full app, add enforces admin and step-up and stores homes under deps.home", async () => {
  const origin = "http://localhost:4100";
  const app = createApp({
    db,
    home,
    port: 4100,
    rp: { id: "localhost", name: "Harness", origin },
    instanceId: "abc",
    version: "1",
    runDeps: { home, port: 4100, resolveSpec: () => null },
  });
  const call = async (opts: { admin: boolean; stepUp: boolean }): Promise<Response> => {
    const { headers } = await sessionHeaders(db, { ...opts, origin });
    return app.request("/api/agents/codex/accounts", {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "work" }),
    });
  };
  expect((await call({ admin: false, stepUp: true })).status).toBe(403);
  expect((await call({ admin: true, stepUp: false })).status).toBe(403);
  const ok = await call({ admin: true, stepUp: true });
  expect(ok.status).toBe(201);
  const created = (await ok.json()) as AccountView;
  expect(created.home).toBe(join(home, "accounts", created.id));
  expect(existsSync(created.home as string)).toBe(true);
});
