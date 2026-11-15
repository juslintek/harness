import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountView } from "../../../shared/accounts";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { fakeCliSpec } from "../../test-support/agents-kit";
import { until, withActor } from "../../test-support/app-kit";
import type { AccountDeps } from "./accounts-login";
import { createAccount, getAccount } from "./accounts-repo";
import { ensureDefaultAccount, getSpec } from "./api";
import type { Runner } from "./discover";
import { agentRoutes } from "./routes";

let db: Database;
let home: string;

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db, migrations);
  home = mkdtempSync(join(tmpdir(), "harness-gate-"));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const noAcp = (): Promise<never> => Promise.reject(new Error("not used"));
const app = (deps: AccountDeps = {}): ReturnType<typeof withActor> =>
  withActor(agentRoutes(db, { listAcp: noAcp }, join(home, "h"), deps));
const post = (a: ReturnType<typeof withActor>, path: string): Response | Promise<Response> =>
  a.request(path, {
    method: "POST",
    body: JSON.stringify({ label: "work" }),
    headers: { "content-type": "application/json" },
  });

const MESSAGE = "this runtime is not enabled for extra accounts yet";

test("no built-in runtime is enabled for extra accounts yet", () => {
  for (const id of ["claude", "codex", "agy", "copilot", "cursor", "junie", "gemini"])
    expect(getSpec(id)?.accountIsolation ?? false).toBe(false);
});

test("add, login and test answer 409 for the real codex and claude specs and the rest", async () => {
  const spawned: string[][] = [];
  const a = app({
    spawn: (argv) => {
      spawned.push(argv);
      return { kill: () => {}, exited: new Promise(() => {}) };
    },
    run: async () => {
      throw new Error("no CLI may run");
    },
  });
  for (const runtime of ["claude", "codex", "agy", "copilot"]) {
    const add = await post(a, `/${runtime}/accounts`);
    expect(add.status).toBe(409);
    expect(await add.json()).toEqual({ error: MESSAGE });
  }
  // A row can exist (made before the gate, or by hand); it still must not log in or be probed.
  const row = createAccount(db, {
    runtime: "claude",
    kind: "login",
    label: "old",
    home: join(home, "x"),
  });
  const codexRow = createAccount(db, {
    runtime: "codex",
    kind: "login",
    label: "old",
    home: join(home, "y"),
  });
  for (const [runtime, account] of [
    ["claude", row],
    ["codex", codexRow],
  ] as const) {
    for (const path of ["login", "test"]) {
      const res = await post(a, `/${runtime}/accounts/${account.id}/${path}`);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: MESSAGE });
    }
  }
  expect(spawned).toEqual([]);
  expect(db.query("SELECT count(*) AS n FROM agent_accounts WHERE label = 'work'").get()).toEqual({
    n: 0,
  });
});

test("codex add, login and test work with the fake CLI", async () => {
  const a = app({ spec: fakeCliSpec("codex") });
  const added = await post(a, "/codex/accounts");
  expect(added.status).toBe(201);
  const account = (await added.json()) as AccountView;
  expect((await post(a, `/codex/accounts/${account.id}/login`)).status).toBe(200);
  await until(() => getAccount(db, account.id)?.state === "active");
  const tested = await post(a, `/codex/accounts/${account.id}/test`);
  expect(((await tested.json()) as AccountView).identityHint).toBe("ChatGPT plus");
});

test("the default account is probed as before, with no account variable", async () => {
  const seen: Array<Record<string, string> | undefined> = [];
  const run: Runner = async (_argv, _ms, env) => {
    seen.push(env);
    return {
      code: 0,
      stdout: '{\n  "loggedIn": true,\n  "subscriptionType": "max"\n}\n',
      stderr: "",
    };
  };
  const def = ensureDefaultAccount(db, "claude");
  const res = await post(app({ run }), `/claude/accounts/${def.id}/test`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as AccountView).state).toBe("active");
  expect(seen).toEqual([undefined]);
  const list = (await (await app().request("/claude/accounts")).json()) as AccountView[];
  expect(list.map((account) => account.id)).toEqual(["default:claude"]);
});
