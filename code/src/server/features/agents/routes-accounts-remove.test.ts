import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountView } from "../../../shared/accounts";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { isolatedStubSpec } from "../../test-support/agents-kit";
import { withActor } from "../../test-support/app-kit";
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

function runOn(accountId: string, state: string): void {
  db.run(
    "INSERT INTO runs (id, agent_id, repo, prompt, state, created_at, account_id) VALUES (?, 'claude', '/r', 'p', ?, 1, ?)",
    [Bun.randomUUIDv7(), state, accountId],
  );
}

test("the label default is reserved, so a later link can still create the default account", async () => {
  for (const label of ["default", "Default"]) {
    expect((await send(routes(), "POST", "/claude/accounts", { label })).status).toBe(409);
  }
  expect((await send(routes(), "POST", "/claude/link", { enabled: true })).status).toBe(200);
  expect(
    db.query("SELECT id FROM agent_accounts WHERE id = 'default:claude'").get(),
  ).not.toBeNull();
});

test("draining twice is a no-op and appends one event, and the drained account can then be removed", async () => {
  const account = await add("work");
  runOn(account.id, "running");
  await send(routes(), "DELETE", `/claude/accounts/${account.id}?drain=1`);
  const again = await send(routes(), "DELETE", `/claude/accounts/${account.id}?drain=1`);
  expect(again.status).toBe(200);
  expect(kinds()).toEqual(["account.added", "account.removed"]);
  db.run("DELETE FROM runs");
  expect((await send(routes(), "DELETE", `/claude/accounts/${account.id}`)).status).toBe(200);
});

test("enabling an active account keeps it active, only a disabled one goes back to unknown", async () => {
  const account = await add("work");
  db.run("UPDATE agent_accounts SET state = 'active' WHERE id = ?", [account.id]);
  const res = await send(routes(), "PATCH", `/claude/accounts/${account.id}`, { enabled: true });
  expect(((await res.json()) as AccountView).state).toBe("active");
  await send(routes(), "PATCH", `/claude/accounts/${account.id}`, { enabled: false });
  const back = await send(routes(), "PATCH", `/claude/accounts/${account.id}`, { enabled: true });
  expect(((await back.json()) as AccountView).state).toBe("unknown");
});

test("a removed account frees its label for reuse", async () => {
  const account = await add("work");
  await send(routes(), "DELETE", `/claude/accounts/${account.id}`);
  const row = db
    .query<{ label: string }, [string]>("SELECT label FROM agent_accounts WHERE id = ?")
    .get(account.id);
  expect(row?.label).toBe(`work~removed~${account.id}`);
  expect((await send(routes(), "POST", "/claude/accounts", { label: "work" })).status).toBe(201);
});

test("two concurrent removals run once and audit once", async () => {
  const account = await add("work");
  const both = await Promise.all([
    send(routes(), "DELETE", `/claude/accounts/${account.id}`),
    send(routes(), "DELETE", `/claude/accounts/${account.id}`),
  ]);
  expect(both.map((res) => res.status).sort()).toEqual([200, 409]);
  expect(kinds()).toEqual(["account.added", "account.removed"]);
});

test("a failing delete keeps the account in removing, audits remove_failed and says so", async () => {
  const account = await add("work");
  const dir = account.home as string;
  writeFileSync(join(dir, "marker"), "x");
  chmodSync(dir, 0o500);
  const res = await send(routes(), "DELETE", `/claude/accounts/${account.id}`);
  chmodSync(dir, 0o700);
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toContain("removing");
  expect(db.query("SELECT state FROM agent_accounts WHERE id = ?").get(account.id)).toEqual({
    state: "removing",
  });
  expect(kinds()).toEqual(["account.added", "account.remove_failed"]);
  expect((await send(routes(), "DELETE", `/claude/accounts/${account.id}`)).status).toBe(200);
});

test("a label can be reused and removed again and again within one second", async () => {
  for (let round = 0; round < 3; round++) {
    const account = await add("work");
    expect((await send(routes(), "DELETE", `/claude/accounts/${account.id}`)).status).toBe(200);
  }
  expect(
    db.query("SELECT count(*) AS n FROM agent_accounts WHERE state = 'removed'").get(),
  ).toEqual({ n: 3 });
});
