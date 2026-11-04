import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, until } from "../kit/client";
import { type SeededSession, seedSession } from "../kit/seed";
import { lazyBoot } from "../kit/server";

// The server runs with a PATH of its own: stub CLIs, and stubs for the three tools the agents code
// shells out to (`which`, `security`, `tmutil`), so no real Keychain or backup setting is touched.
const bin = realpathSync(mkdtempSync(join(tmpdir(), "harness-agents-bin-")));
const script = (name: string, body: string): void => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
script("which", 'command -v "$1"');
script("security", "exit 44");
script("tmutil", "exit 0");
script(
  "alpha",
  'case "$1" in --version) echo "alpha 1.2.3";; status) echo \'{"loggedIn": true}\';; login) echo $$ > "$ALPHA_PID"; exec /bin/sleep 20;; esac',
);
script("gamma", "echo kaboom >&2; exit 3");
script("delta", 'case "$1" in --version) echo "delta 0.0.1";; *) exec /bin/sleep 31337;; esac');
script(
  "agy",
  'case "$1" in --version) echo "agy 0.0.7";; models) printf "Fetching available models...\\ngemini-x-low\\tGemini X Low\\nplain-id\\n";; esac',
);

const spec = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: id.toUpperCase(),
  lane: "acp",
  bin: "/bin/echo",
  args: [],
  versionArgs: [id, "--version"],
  loginProbe: null,
  loginArgs: null,
  modeOption: null,
  egress: [],
  stateWrite: [],
  weakerNetworkIsolation: false,
  claudeMeta: false,
  ...over,
});

const agents = [
  spec("alpha", {
    loginProbe: { args: ["alpha", "status"], loggedInWhen: { stdoutIncludes: '"loggedIn": true' } },
    loginArgs: ["alpha", "login"],
  }),
  spec("beta"),
  spec("gamma"),
  spec("delta", {
    loginProbe: { args: ["delta", "probe"], loggedInWhen: "exit0" },
  }),
  spec("agy", {
    lane: "agy",
    loginProbe: { args: ["agy", "models"], loggedInWhen: "exit0" },
  }),
  spec("apix", { lane: "api" }),
  spec("missingcli", { loginArgs: ["definitely-not-installed-xyz", "login"] }),
];

const pidFile = join(bin, "alpha.pid");
const ollaya = Bun.serve({ port: 0, fetch: () => Response.json({ version: "9.9.9" }) });
let fresh: SeededSession;
let stale: SeededSession;
let plain: SeededSession;

const lazy = lazyBoot({
  seed: (db) => {
    fresh = seedSession(db, { admin: true, stepUp: true });
    stale = seedSession(db, { admin: true });
    plain = seedSession(db);
  },
  env: {
    PATH: bin,
    HARNESS_TEST_AGENTS: JSON.stringify(agents),
    ALPHA_PID: pidFile,
    OPENROUTER_API_KEY: "env-key-0123456789abcdefghij",
    OLLAYA_URL: `http://127.0.0.1:${ollaya.port}`,
  },
});
afterAll(async () => {
  try {
    await lazy.stop();
  } finally {
    await ollaya.stop(true);
    rmSync(bin, { recursive: true, force: true });
  }
});

const sleeping = (marker: string): boolean => Bun.spawnSync(["pgrep", "-f", marker]).exitCode === 0;

test("C2-agents-discovery: versions, paths, login state and probe timeouts [phase:2] [slice:agents]", async () => {
  const server = await lazy.get();
  const me = api(server, fresh);
  const started = Date.now();
  const list = await me.json<Array<Record<string, unknown>>>("GET", "/api/agents");
  const byId = Object.fromEntries(list.map((agent) => [agent.id, agent]));
  expect(list.map((agent) => agent.id)).toEqual(agents.map((a) => a.id));
  expect(byId.alpha).toEqual({
    id: "alpha",
    name: "ALPHA",
    lane: "acp",
    installed: true,
    path: join(bin, "alpha"),
    version: "1.2.3",
    loggedIn: true,
    error: null,
    canLogin: true,
    enabled: false,
    models: [],
  });
  expect(byId.beta).toMatchObject({ installed: false, path: null, version: null, error: null });
  expect(byId.gamma).toMatchObject({ installed: false, error: "kaboom" });
  expect(byId.delta).toMatchObject({
    installed: true,
    version: "0.0.1",
    loggedIn: null,
    error: "timed out after 5000 ms",
  });
  expect(byId.agy).toMatchObject({ installed: true, version: "0.0.7", loggedIn: true });
  expect(Date.now() - started).toBeLessThan(9000);
  // The timed out probe is not left running.
  await until(() => !sleeping("sleep 31337"), "the hanging probe to be gone", 5000);

  // A second call inside the minute answers from the cache.
  const again = Date.now();
  expect(await me.json("GET", "/api/agents")).toEqual(list);
  expect(Date.now() - again).toBeLessThan(2000);
});

test("C2-agents-discovery: only an instance admin gets in [phase:2] [slice:agents]", async () => {
  const server = await lazy.get();
  expect((await api(server).call("GET", "/api/agents")).status).toBe(401);
  const res = await api(server, plain).call("GET", "/api/agents");
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "forbidden" });
});

test("C2-agents-link: needs a fresh step-up, a known agent and a boolean [phase:2] [slice:agents]", async () => {
  const server = await lazy.get();
  const post = (session: SeededSession, id: string, body: unknown) =>
    api(server, session).call("POST", `/api/agents/${id}/link`, { body });
  const denied = await post(stale, "alpha", { enabled: true });
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: "step_up_required" });
  expect((await post(fresh, "nope", { enabled: true })).status).toBe(404);
  const bad = await post(fresh, "alpha", { enabled: "yes" });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ error: "invalid body" });
  const ok = await post(fresh, "alpha", { enabled: true });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ ok: true });
  const list = await api(server, fresh).json<Array<{ id: string; enabled: boolean }>>(
    "GET",
    "/api/agents",
  );
  expect(list.find((agent) => agent.id === "alpha")?.enabled).toBe(true);
});

test("C2-agents-keys: validation, the secrets file and where a key comes from [phase:2] [slice:agents]", async () => {
  const server = await lazy.get();
  const secret = "sk-test-0123456789abcdefghij";
  const save = (session: SeededSession, provider: string, body: unknown) =>
    api(server, session).call("POST", `/api/agents/keys/${provider}`, { body });

  const denied = await save(stale, "openai", { key: secret });
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: "step_up_required" });
  expect((await save(stale, "nope", { key: secret })).status).toBe(403);
  const unknown = await save(fresh, "nope", { key: secret });
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({ error: "unknown provider" });
  for (const key of ["short", `${"a".repeat(19)}\n`, "é".repeat(30), 5, null]) {
    const res = await save(fresh, "openai", { key });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid key" });
  }
  expect((await save(fresh, "openai", "not an object")).status).toBe(400);

  const before = await api(server, fresh).json("GET", "/api/agents/keys");
  expect(before).toEqual([
    { provider: "anthropic", source: null, legacyLeft: false },
    { provider: "openai", source: null, legacyLeft: false },
    { provider: "gemini", source: null, legacyLeft: false },
    { provider: "openrouter", source: "env", legacyLeft: false },
  ]);

  const ok = await save(fresh, "openai", { key: secret });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ ok: true });
  const file = join(server.home, "secrets.json");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ openai: secret });
  expect(readFileSync(file, "utf8")).toBe(JSON.stringify({ openai: secret }));
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(server.home).mode & 0o777).toBe(0o700);

  await save(fresh, "gemini", { key: "gemini-key-0123456789abcdef" });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    openai: secret,
    gemini: "gemini-key-0123456789abcdef",
  });
  const after = await api(server, fresh).json<Array<{ provider: string; source: string | null }>>(
    "GET",
    "/api/agents/keys",
  );
  expect(after.map((entry) => entry.source)).toEqual([null, "file", "file", "env"]);
  // The key itself never comes back.
  expect(JSON.stringify(after)).not.toContain(secret);
});

test("C2-agents-models: agy output is saved, other lanes are refused [phase:2] [slice:agents]", async () => {
  const server = await lazy.get();
  const me = api(server, fresh);
  const ok = await me.call("POST", "/api/agents/agy/models");
  expect(ok.status).toBe(200);
  const expected = [
    { id: "gemini-x-low", name: "Gemini X Low" },
    { id: "plain-id", name: "plain-id" },
  ];
  expect(await ok.json()).toEqual({ models: expected });
  const list = await me.json<Array<{ id: string; models: unknown }>>("GET", "/api/agents");
  expect(list.find((agent) => agent.id === "agy")?.models).toEqual(expected);

  const unknown = await me.call("POST", "/api/agents/nope/models");
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({ error: "unknown agent" });
  const api409 = await me.call("POST", "/api/agents/apix/models");
  expect(api409.status).toBe(409);
  expect(await api409.json()).toEqual({ error: "APIX has no model list to refresh" });
});

test("C2-agents-login: one command at a time, and a missing cli is refused [phase:2] [slice:agents]", async () => {
  const server = await lazy.get();
  const post = (session: SeededSession, id: string) =>
    api(server, session).call("POST", `/api/agents/${id}/login`);
  const denied = await post(stale, "alpha");
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: "step_up_required" });
  const none = await post(fresh, "beta");
  expect(none.status).toBe(404);
  expect(await none.json()).toEqual({ error: "no login command" });

  const missing = await post(fresh, "missingcli");
  expect(missing.status).toBe(409);
  expect(await missing.json()).toEqual({
    error: "definitely-not-installed-xyz could not be started, is it installed?",
  });

  const first = await post(fresh, "alpha");
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ command: ["alpha", "login"] });
  const pid = await until(() => {
    try {
      return readFileSync(pidFile, "utf8").trim() || null;
    } catch {
      return null;
    }
  }, "the login command to start");
  const second = await post(fresh, "alpha");
  expect(await second.json()).toEqual({ command: ["alpha", "login"] });
  expect(readFileSync(pidFile, "utf8").trim()).toBe(pid);
});

test("C2-agents-ollaya: the status of the Ollaya service [phase:2] [slice:agents]", async () => {
  const server = await lazy.get();
  const res = await api(server, fresh).call("GET", "/api/agents/ollaya");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ up: true, version: "9.9.9" });
});
