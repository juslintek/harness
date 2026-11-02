import type { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { withActor } from "../../test-support/app-kit";
import {
  LoginError,
  type LoginProcess,
  listAgents,
  saveModels,
  setLinked,
  startLogin,
} from "./api";
import type { Runner } from "./discover";
import { agentRoutes } from "./routes";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db, migrations);
});

const post = (
  app: { request: ReturnType<typeof withActor>["request"] },
  path: string,
  body: unknown,
): Response | Promise<Response> =>
  app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

test("link toggles persist and unknown agents are rejected", async () => {
  const app = withActor(agentRoutes(db));
  expect((await post(app, "/claude/link", { enabled: true })).status).toBe(200);
  expect(db.query("SELECT enabled FROM agent_links WHERE agent_id = 'claude'").get()).toEqual({
    enabled: 1,
  });
  expect((await post(app, "/nope/link", { enabled: true })).status).toBe(404);
  expect((await post(app, "/claude/link", { enabled: "yes" })).status).toBe(400);
});

test("link toggles and key saves need a fresh step-up", async () => {
  const app = withActor(agentRoutes(db), { stepUpAt: null });
  const link = await post(app, "/claude/link", { enabled: true });
  expect(link.status).toBe(403);
  expect(await link.json()).toEqual({ error: "step_up_required" });
  expect((await post(app, "/keys/openai", { key: "a".repeat(30) })).status).toBe(403);
});

test("starting a host-side login needs a fresh step-up", async () => {
  const app = withActor(agentRoutes(db), { stepUpAt: null });
  const res = await post(app, "/codex/login", {});
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "step_up_required" });
});

test("keys are validated before anything is stored", async () => {
  const app = withActor(agentRoutes(db));
  expect((await post(app, "/keys/openai", { key: "short" })).status).toBe(400);
  expect((await post(app, "/keys/openai", { key: `${"a".repeat(19)}\n` })).status).toBe(400);
  expect((await post(app, "/keys/nope", { key: "a".repeat(30) })).status).toBe(404);
});

test("login is refused for agents without a login command", async () => {
  expect((await post(withActor(agentRoutes(db)), "/agy/login", {})).status).toBe(404);
});

function fakeLogin(): {
  spawn: (argv: string[]) => LoginProcess;
  spawned: string[][];
  killed: number[];
  finish: () => void;
} {
  const spawned: string[][] = [];
  const killed: number[] = [];
  let finish = (): void => {};
  const spawn = (argv: string[]): LoginProcess => {
    spawned.push(argv);
    return {
      kill: () => killed.push(1),
      exited: new Promise((resolve) => (finish = () => resolve(0))),
    };
  };
  return { spawn, spawned, killed, finish: () => finish() };
}

test("startLogin runs loginArgs, returns the command and refuses agents without one", () => {
  const fake = fakeLogin();
  expect(startLogin("codex", fake.spawn)).toEqual({ command: ["codex", "login"] });
  expect(fake.spawned).toEqual([["codex", "login"]]);
  expect(() => startLogin("agy", fake.spawn)).toThrow(LoginError);
  fake.finish();
});

test("a second login while one is running reuses it, and a new one starts after it exits", async () => {
  const fake = fakeLogin();
  startLogin("cursor", fake.spawn);
  expect(startLogin("cursor", fake.spawn)).toEqual({ command: ["agent", "login"] });
  expect(fake.spawned).toHaveLength(1);
  fake.finish();
  await Bun.sleep(5);
  startLogin("cursor", fake.spawn);
  expect(fake.spawned).toHaveLength(2);
  fake.finish();
});

test("a login that outlives the timeout is killed", async () => {
  const fake = fakeLogin();
  startLogin("copilot", fake.spawn, 10);
  await Bun.sleep(40);
  expect(fake.killed).toHaveLength(1);
  fake.finish();
});

test("a missing cli is a LoginError, not a crash, and leaves nothing in flight", () => {
  const broken = (): LoginProcess => {
    throw new Error("ENOENT");
  };
  expect(() => startLogin("claude", broken)).toThrow(LoginError);
  const fake = fakeLogin();
  startLogin("claude", fake.spawn);
  expect(fake.spawned).toHaveLength(1);
  fake.finish();
});

test("saved models and link state show up in the agent list", async () => {
  setLinked(db, "codex", true);
  saveModels(db, "codex", [{ id: "m1", name: "Model One" }]);
  const agents = await listAgents(db, async () => ({ code: 127, stdout: "", stderr: "" }));
  const codex = agents.find((agent) => agent.id === "codex");
  expect(codex).toMatchObject({
    enabled: true,
    installed: false,
    models: [{ id: "m1", name: "Model One" }],
  });
});

const agyOut =
  (stdout: string, code = 0): Runner =>
  async () => ({ code, stdout, stderr: code === 0 ? "" : "Error: please sign in" });
const noAcp = (): Promise<never> => Promise.reject(new Error("not used"));

test("models refresh: agy output is parsed and saved, failures keep the old list", async () => {
  saveModels(db, "agy", [{ id: "old", name: "Old" }]);
  const ok = agentRoutes(db, {
    listAcp: noAcp,
    run: agyOut("Fetching available models...\ngemini-x-low\tGemini X Low\nplain-id\n\n"),
  });
  const res = await post(ok, "/agy/models", {});
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    models: [
      { id: "gemini-x-low", name: "Gemini X Low" },
      { id: "plain-id", name: "plain-id" },
    ],
  });
  expect(
    (await listAgents(db, async () => ({ code: 0, stdout: "", stderr: "" })))
      .find((a) => a.id === "agy")
      ?.models.map((m) => m.id),
  ).toEqual(["gemini-x-low", "plain-id"]);
  const failing = agentRoutes(db, { listAcp: noAcp, run: agyOut("", 1) });
  expect((await post(failing, "/agy/models", {})).status).toBe(502);
  expect(
    (await post(agentRoutes(db, { listAcp: noAcp, run: agyOut("\n") }), "/agy/models", {})).status,
  ).toBe(502);
  expect(db.query("SELECT count(*) AS n FROM agent_models WHERE agent_id = 'agy'").get()).toEqual({
    n: 2,
  });
});

test("models refresh: ACP agents go through listAcp, unknown agents are 404", async () => {
  const seen: string[] = [];
  const app = agentRoutes(db, {
    listAcp: async (spec) => {
      seen.push(spec.id);
      return [{ id: "m1", name: "M1" }];
    },
  });
  const res = await post(app, "/claude/models", {});
  expect(res.status).toBe(200);
  expect(seen).toEqual(["claude"]);
  expect((await post(app, "/nope/models", {})).status).toBe(404);
  const broken = agentRoutes(db, { listAcp: noAcp });
  expect((await post(broken, "/claude/models", {})).status).toBe(502);
});

test("models refresh: concurrent requests for one agent share one probe", async () => {
  let probes = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const app = agentRoutes(db, {
    listAcp: async () => {
      probes++;
      await gate;
      return [{ id: "m1", name: "M1" }];
    },
  });
  const both = Promise.all([post(app, "/claude/models", {}), post(app, "/claude/models", {})]);
  await Bun.sleep(20);
  release();
  expect((await both).map((r) => r.status)).toEqual([200, 200]);
  expect(probes).toBe(1);
  await post(app, "/claude/models", {});
  expect(probes).toBe(2);
});
