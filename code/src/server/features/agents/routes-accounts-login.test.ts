import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountView } from "../../../shared/accounts";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { fakeCliSpec, isolatedStubSpec } from "../../test-support/agents-kit";
import { until, withActor } from "../../test-support/app-kit";
import { readBody } from "../logs/api";
import { type AccountDeps, testAccount } from "./accounts-login";
import { createAccount, getAccount } from "./accounts-repo";
import type { LoginProcess } from "./api";
import type { Runner } from "./discover";
import { agentRoutes } from "./routes";

let db: Database;
let home: string;
let log: string;
const before = { log: process.env.FAKE_BIN_LOG, home: process.env.FAKE_DEFAULT_HOME };

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db, migrations);
  home = mkdtempSync(join(tmpdir(), "harness-acct-routes-"));
  log = join(home, "calls.log");
  process.env.FAKE_BIN_LOG = log;
  process.env.FAKE_DEFAULT_HOME = join(home, "default-home");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of [
    ["FAKE_BIN_LOG", before.log],
    ["FAKE_DEFAULT_HOME", before.home],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const noAcp = (): Promise<never> => Promise.reject(new Error("not used"));
const app = (
  deps: AccountDeps,
  session?: Parameters<typeof withActor>[1],
): ReturnType<typeof withActor> =>
  withActor(agentRoutes(db, { listAcp: noAcp }, join(home, "h"), deps), session);

const post = (a: ReturnType<typeof withActor>, path: string): Response | Promise<Response> =>
  a.request(path, {
    method: "POST",
    body: JSON.stringify({ label: "work" }),
    headers: { "content-type": "application/json" },
  });

async function addWork(a: ReturnType<typeof withActor>, runtime = "claude"): Promise<AccountView> {
  return (await (await post(a, `/${runtime}/accounts`)).json()) as AccountView;
}

test("login and test need a fresh step-up", async () => {
  const stale = app({ spec: fakeCliSpec("claude") }, { stepUpAt: null });
  for (const path of ["/claude/accounts/x/login", "/claude/accounts/x/test"]) {
    const res = await post(stale, path);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "step_up_required" });
  }
});

test("login runs the fake CLI in the account's home and the account becomes active", async () => {
  const a = app({ spec: fakeCliSpec("claude") });
  const account = await addWork(a);
  const res = await post(a, `/claude/accounts/${account.id}/login`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { command: string[] }).command.slice(1)).toEqual(["auth", "login"]);
  await until(() => getAccount(db, account.id)?.state === "active");
  expect(getAccount(db, account.id)?.identityHint).toBe("max");
  expect(existsSync(join(account.home as string, ".fake-login"))).toBe(true);
  expect(readFileSync(log, "utf8")).toContain(`config=${account.home}`);
});

test("test re-probes on demand and appends account.tested", async () => {
  const a = app({ spec: fakeCliSpec("claude") });
  const account = await addWork(a);
  const res = await post(a, `/claude/accounts/${account.id}/test`);
  expect(((await res.json()) as AccountView).state).toBe("logged_out");
  expect(db.query("SELECT count(*) AS n FROM events WHERE kind = 'account.tested'").get()).toEqual({
    n: 1,
  });
});

test("login and test are 404 for an unknown account and 409 for a disabled one", async () => {
  const a = app({ spec: fakeCliSpec("claude") });
  expect((await post(a, "/claude/accounts/missing/login")).status).toBe(404);
  const account = await addWork(a);
  await a.request(`/claude/accounts/${account.id}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled: false }),
    headers: { "content-type": "application/json" },
  });
  expect((await post(a, `/claude/accounts/${account.id}/login`)).status).toBe(409);
  expect((await post(a, `/claude/accounts/${account.id}/test`)).status).toBe(409);
});

test("remove runs the vendor logout with the account's environment before deleting", async () => {
  const a = app({ spec: fakeCliSpec("codex") });
  const account = await addWork(a, "codex");
  const res = await a.request(`/codex/accounts/${account.id}`, { method: "DELETE" });
  expect(res.status).toBe(200);
  expect(readFileSync(log, "utf8")).toContain(`codex logout home=${account.home}`);
  expect(existsSync(account.home as string)).toBe(false);
});

test("a spec without a logout command skips the CLI step and still removes", async () => {
  const a = app({ spec: isolatedStubSpec() });
  const account = await addWork(a);
  expect((await a.request(`/claude/accounts/${account.id}`, { method: "DELETE" })).status).toBe(
    200,
  );
  expect(existsSync(log)).toBe(false);
});

test("a failing logout does not block removal and is recorded", async () => {
  const failing = { ...fakeCliSpec("codex"), logoutArgs: ["/nonexistent/codex", "logout"] };
  const a = app({ spec: failing });
  const account = await addWork(a, "codex");
  expect((await a.request(`/codex/accounts/${account.id}`, { method: "DELETE" })).status).toBe(200);
  expect(getAccount(db, account.id)?.state).toBe("removed");
  const rowid = db
    .query<{ rowid: number }, []>("SELECT rowid FROM events WHERE kind = 'account.removed'")
    .get()?.rowid;
  expect(readBody(db, rowid as number)).toContain("logout failed");
});

test("removing an account stops a login that is still running before the home is deleted", async () => {
  let killed = 0;
  const spawn = (): LoginProcess => {
    let finish: (value: unknown) => void = () => {};
    const exited = new Promise((resolve) => {
      finish = resolve;
    });
    return {
      kill: () => {
        killed++;
        finish(143);
      },
      exited,
    };
  };
  const a = app({ spec: fakeCliSpec("claude"), spawn });
  const account = await addWork(a);
  await post(a, `/claude/accounts/${account.id}/login`);
  const res = await a.request(`/claude/accounts/${account.id}`, { method: "DELETE" });
  expect(res.status).toBe(200);
  expect(killed).toBe(1);
  expect(existsSync(account.home as string)).toBe(false);
  await Bun.sleep(30);
  expect(getAccount(db, account.id)?.state).toBe("removed");
});

test("a probe that finishes after the account was disabled does not undo the disable", async () => {
  const account = createAccount(db, { runtime: "claude", kind: "login", label: "w", home: home });
  const slow: Runner = async () => {
    db.run("UPDATE agent_accounts SET state = 'disabled' WHERE id = ?", [account.id]);
    return { code: 0, stdout: '{"loggedIn": true}', stderr: "" };
  };
  await expect(
    testAccount(db, "claude", account.id, { spec: fakeCliSpec("claude"), run: slow }),
  ).rejects.toThrow("disabled");
  expect(getAccount(db, account.id)?.state).toBe("disabled");
});
