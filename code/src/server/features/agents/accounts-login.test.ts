import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountView } from "../../../shared/accounts";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { fakeCliSpec as fakeSpec } from "../../test-support/agents-kit";
import { until } from "../../test-support/app-kit";
import { startAccountLogin, testAccount } from "./accounts-login";
import { createAccount, getAccount } from "./accounts-repo";
import { ensureDefaultAccount, type LoginProcess } from "./api";

let db: Database;
let dir: string;
const before = process.env.FAKE_DEFAULT_HOME;

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db, migrations);
  dir = mkdtempSync(join(tmpdir(), "harness-login-"));
  process.env.FAKE_DEFAULT_HOME = join(dir, "default-home");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (before === undefined) delete process.env.FAKE_DEFAULT_HOME;
  else process.env.FAKE_DEFAULT_HOME = before;
});

function account(label: string): AccountView {
  return createAccount(db, { runtime: "claude", kind: "login", label, home: join(dir, label) });
}

function fakeLogin(): {
  spawn: (argv: string[], env: Record<string, string>) => LoginProcess;
  spawned: Array<{ argv: string[]; env: Record<string, string> }>;
  killed: number[];
  finish: () => void;
} {
  const spawned: Array<{ argv: string[]; env: Record<string, string> }> = [];
  const killed: number[] = [];
  let finish = (): void => {};
  const spawn = (argv: string[], env: Record<string, string>): LoginProcess => {
    spawned.push({ argv, env });
    return {
      kill: () => killed.push(1),
      exited: new Promise((resolve) => (finish = () => resolve(0))),
    };
  };
  return { spawn, spawned, killed, finish: () => finish() };
}

test("login for B spawns the login argv with B's home and without A's", () => {
  const a = account("a");
  const b = account("b");
  const fake = fakeLogin();
  const loginArgv = fakeSpec("claude").loginArgs as string[];
  expect(
    startAccountLogin(db, "claude", b.id, { spawn: fake.spawn, spec: fakeSpec("claude") }),
  ).toEqual({ command: loginArgv });
  expect(fake.spawned).toEqual([{ argv: loginArgv, env: { CLAUDE_CONFIG_DIR: b.home as string } }]);
  expect(JSON.stringify(fake.spawned)).not.toContain(a.home as string);
  fake.finish();
});

test("the default account launches the login with no extra variable", () => {
  const fake = fakeLogin();
  const def = ensureDefaultAccount(db, "claude");
  startAccountLogin(db, "claude", def.id, { spawn: fake.spawn, spec: fakeSpec("claude") });
  expect(fake.spawned[0]?.env).toEqual({});
  fake.finish();
});

test("when the login process exits the account is tested and its state updates", async () => {
  const b = account("b");
  // The fake CLI writes the marker, so this runs the whole path: spawn, exit, test.
  startAccountLogin(db, "claude", b.id, { spec: fakeSpec("claude") });
  await until(() => getAccount(db, b.id)?.state === "active");
  expect(getAccount(db, b.id)).toMatchObject({ state: "active", identityHint: "max" });
  expect(getAccount(db, b.id)?.lastProbeAt).not.toBeNull();
});

test("with an injected process the test runs only after it exits", async () => {
  const fake = fakeLogin();
  const b = account("b");
  const spec = fakeSpec("claude");
  startAccountLogin(db, "claude", b.id, { spec, spawn: fake.spawn });
  await Bun.sleep(30);
  expect(getAccount(db, b.id)?.state).toBe("pending");
  fake.finish();
  await until(() => getAccount(db, b.id)?.state === "logged_out");
  expect(getAccount(db, b.id)?.lastProbeAt).not.toBeNull();
});

test("a second login for the same account reuses the running one, another account starts its own", () => {
  const fake = fakeLogin();
  const a = account("a");
  const b = account("b");
  startAccountLogin(db, "claude", a.id, { spawn: fake.spawn, spec: fakeSpec("claude") });
  startAccountLogin(db, "claude", a.id, { spawn: fake.spawn, spec: fakeSpec("claude") });
  startAccountLogin(db, "claude", b.id, { spawn: fake.spawn, spec: fakeSpec("claude") });
  expect(fake.spawned).toHaveLength(2);
  fake.finish();
});

test("a login that outlives the timeout is killed", async () => {
  const fake = fakeLogin();
  startAccountLogin(db, "claude", account("a").id, {
    spawn: fake.spawn,
    timeoutMs: 10,
    spec: fakeSpec("claude"),
  });
  await Bun.sleep(40);
  expect(fake.killed).toHaveLength(1);
  fake.finish();
});

test("testAccount refuses disabled and removed accounts so a test cannot undo the disable", async () => {
  const a = account("a");
  db.run("UPDATE agent_accounts SET state = 'disabled' WHERE id = ?", [a.id]);
  await expect(testAccount(db, "claude", a.id, { spec: fakeSpec("claude") })).rejects.toThrow(
    "disabled",
  );
  expect(getAccount(db, a.id)?.state).toBe("disabled");
});

test("testAccount appends account.tested with the state and nothing else", async () => {
  const a = account("a");
  await testAccount(db, "claude", a.id, { spec: fakeSpec("claude") });
  expect(db.query("SELECT kind, agent FROM events WHERE kind = 'account.tested'").all()).toEqual([
    { kind: "account.tested", agent: "claude" },
  ]);
});
