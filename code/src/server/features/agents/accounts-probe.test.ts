import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeCliSpec as fakeSpec } from "../../test-support/agents-kit";
import { probeAccount, type Runner } from "./discover";
import { type AgentSpec, accountEnv, agentSpecs, loadAgentSpecs } from "./specs";

let dir: string;
let log: string;
const before = { log: process.env.FAKE_BIN_LOG, home: process.env.FAKE_DEFAULT_HOME };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-probe-"));
  log = join(dir, "calls.log");
  process.env.FAKE_BIN_LOG = log;
  process.env.FAKE_DEFAULT_HOME = join(dir, "default-home");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ["FAKE_BIN_LOG", before.log],
    ["FAKE_DEFAULT_HOME", before.home],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function loggedInHome(name: string, marker: string): string {
  const home = join(dir, name);
  mkdirSync(home);
  writeFileSync(join(home, marker), "max");
  return home;
}

test("accountEnv names the config dir variable per runtime and nothing for a NULL home", () => {
  expect(accountEnv({ id: "claude" }, { home: "/h/a" })).toEqual({ CLAUDE_CONFIG_DIR: "/h/a" });
  expect(accountEnv({ id: "codex" }, { home: "/h/a" })).toEqual({ CODEX_HOME: "/h/a" });
  expect(accountEnv({ id: "agy" }, { home: "/h/a" })).toEqual({});
  expect(accountEnv({ id: "claude" }, { home: null })).toEqual({});
  expect(accountEnv({ id: "codex" }, { home: null })).toEqual({});
});

test("claude: account A with a marker is active, account B without one is logged out", async () => {
  const spec = fakeSpec("claude");
  const a = loggedInHome("a", ".fake-login");
  const b = join(dir, "b");
  mkdirSync(b);
  expect(await probeAccount(spec, { home: a })).toEqual({ state: "active", identityHint: "max" });
  expect(await probeAccount(spec, { home: b })).toEqual({
    state: "logged_out",
    identityHint: null,
  });
  const calls = readFileSync(log, "utf8");
  expect(calls).toContain(`claude auth status config=${a}`);
  expect(calls).toContain(`claude auth status config=${b}`);
});

test("codex: the probe carries the account's CODEX_HOME and reads the plan line", async () => {
  const spec = fakeSpec("codex");
  const a = loggedInHome("a", "auth.json");
  const b = join(dir, "b");
  mkdirSync(b);
  expect(await probeAccount(spec, { home: a })).toEqual({
    state: "active",
    identityHint: "ChatGPT max",
  });
  expect((await probeAccount(spec, { home: b })).state).toBe("logged_out");
  const calls = readFileSync(log, "utf8");
  expect(calls).toContain(`codex login status home=${a}`);
});

test("the default account is probed with no account variable, exactly as before", async () => {
  mkdirSync(process.env.FAKE_DEFAULT_HOME as string);
  writeFileSync(join(process.env.FAKE_DEFAULT_HOME as string, ".fake-login"), "pro");
  const probe = await probeAccount(fakeSpec("claude"), { home: null });
  expect(probe).toEqual({ state: "active", identityHint: "pro" });
  expect(readFileSync(log, "utf8")).toContain("claude auth status config=<unset>");
});

test("a NULL home keeps the codex probe pinned to the loginProbe env, a home overrides it", async () => {
  const seen: Array<Record<string, string> | undefined> = [];
  const run: Runner = async (_argv, _ms, env) => {
    seen.push(env);
    return { code: 1, stdout: "", stderr: "" };
  };
  const spec = agentSpecs.find((candidate) => candidate.id === "codex") as AgentSpec;
  await probeAccount(spec, { home: null }, run);
  await probeAccount(spec, { home: "/h/b" }, run);
  expect(seen).toEqual([spec.loginProbe?.env, { CODEX_HOME: "/h/b" }]);
  const claude = agentSpecs.find((candidate) => candidate.id === "claude") as AgentSpec;
  await probeAccount(claude, { home: null }, run);
  expect(seen[2]).toBeUndefined();
});

test("a missing cli or a runner that throws is probe_failed, not logged out", async () => {
  const spec = fakeSpec("claude");
  const missing = {
    ...spec,
    loginProbe: { ...(spec.loginProbe as object), args: ["/nonexistent/claude", "auth", "status"] },
  } as AgentSpec;
  expect((await probeAccount(missing, { home: dir })).state).toBe("probe_failed");
  const boom: Runner = async () => {
    throw new Error("timed out");
  };
  expect((await probeAccount(spec, { home: dir }, boom)).state).toBe("probe_failed");
  const noProbe = agentSpecs.find((candidate) => candidate.id === "junie") as AgentSpec;
  expect((await probeAccount(noProbe, { home: null })).state).toBe("probe_failed");
});

test("the identity hint never carries a token, an email or a long opaque string", async () => {
  const token = "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  const stdout = JSON.stringify(
    {
      loggedIn: true,
      authMethod: "claude.ai",
      subscriptionType: "pro",
      orgName: "Acme Ltd",
      email: "a@b.example",
      accessToken: token,
    },
    null,
    2,
  );
  const run: Runner = async () => ({ code: 0, stdout, stderr: "" });
  const probe = await probeAccount(fakeSpec("claude"), { home: dir }, run);
  expect(probe).toEqual({ state: "active", identityHint: "pro, Acme Ltd" });
  const hostile = JSON.stringify(
    { loggedIn: true, subscriptionType: token, orgName: "me@example.com" },
    null,
    2,
  );
  const second = await probeAccount(fakeSpec("claude"), { home: dir }, async () => ({
    code: 0,
    stdout: hostile,
    stderr: "",
  }));
  expect(second.identityHint).toBeNull();
  const codexOut = `Logged in using ChatGPT\nPlan: ${token}\n`;
  const third = await probeAccount(fakeSpec("codex"), { home: dir }, async () => ({
    code: 0,
    stdout: codexOut,
    stderr: "",
  }));
  expect(third.identityHint).toBe("ChatGPT");
});

test("segmented, opaque and path-like values never become a hint, plain plan names do", async () => {
  const hostile = [
    "abcdefghijklmnopqrs.tuvwxyzabcdefghij.klmnopqrstuvwxyzab",
    "eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4",
    "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "abcdefghijklmnop",
    "aaaaaaaa.bbbbbbbb",
    "me@example.com",
    "/Users/me/.claude",
    "C:\\Users\\me",
    "x".repeat(49),
  ];
  const hint = async (value: string): Promise<string | null> => {
    const stdout = JSON.stringify({ loggedIn: true, subscriptionType: value }, null, 2);
    return (
      await probeAccount(fakeSpec("claude"), { home: dir }, async () => ({
        code: 0,
        stdout,
        stderr: "",
      }))
    ).identityHint;
  };
  for (const value of hostile) expect(await hint(value)).toBeNull();
  expect(await hint("self_serve_business_prolite")).toBe("self_serve_business_prolite");
  expect(await hint("Claude Team")).toBe("Claude Team");
  expect(await hint("Max 20x")).toBe("Max 20x");
});

test("the fake CLIs load through HARNESS_TEST_AGENTS like the black-box suite does", async () => {
  const fakes = [fakeSpec("claude"), fakeSpec("codex")];
  const specs = loadAgentSpecs({ HARNESS_TEST: "1", HARNESS_TEST_AGENTS: JSON.stringify(fakes) });
  expect(specs).toEqual(fakes);
  const codex = specs.find((spec) => spec.id === "codex") as AgentSpec;
  expect(codex.accountIsolation).toBe(true);
  expect(codex.logoutArgs).toEqual(fakeSpec("codex").logoutArgs);
  const a = loggedInHome("a", "auth.json");
  expect(await probeAccount(codex, { home: a })).toEqual({
    state: "active",
    identityHint: "ChatGPT max",
  });
});
