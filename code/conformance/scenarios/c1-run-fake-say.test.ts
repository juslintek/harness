import { afterAll, expect, test } from "bun:test";
import { wsMessageSchema } from "../../src/shared/realtime";
import { runDetailSchema } from "../../src/shared/runs";
import { api, openWs, until } from "../kit/client";
import { fakeAgent, lazyRepo, liveProcesses } from "../kit/fixtures";
import { type SeededSession, seedSession } from "../kit/seed";
import { lazyBoot } from "../kit/server";

const MARKER = `conformance-say-${crypto.randomUUID()}`;
const ENDED = new Set(["completed", "failed", "blocked", "cancelled", "killed"]);
const repo = lazyRepo();
let admin: SeededSession;

const lazy = lazyBoot({
  seed: (db) => {
    admin = seedSession(db, { admin: true, stepUp: true });
  },
  agents: [fakeAgent("fake", [{ say: "hello from the fake agent" }], MARKER)],
});
afterAll(async () => {
  try {
    await lazy.stop();
  } finally {
    repo.remove();
  }
});

test("C1-run-fake-say: a run completes and its events are readable [phase:1] [slice:runs] [focus:2] [race:ws-vs-run]", async () => {
  const server = await lazy.get();
  const me = api(server, admin);
  const runs = await openWs(server, "runs", admin);
  const { id } = await me.json<{ id: string }>("POST", "/api/runs", {
    body: { agentId: "fake", repo: repo.path(), prompt: "say hello" },
  });
  expect(id).toMatch(/^[0-9a-f-]{36}$/);

  const view = await until(async () => {
    const list = await me.json<{ id: string; state: string }[]>("GET", "/api/runs");
    const run = list.find((r) => r.id === id);
    return run && ENDED.has(run.state) ? run : null;
  }, "the run to end");
  expect(view.state).toBe("completed");

  const detail = runDetailSchema.parse(await me.json("GET", `/api/runs/${id}`));
  expect(detail.run.state).toBe("completed");
  expect(detail.run.agentId).toBe("fake");
  const said = detail.events.filter((e) => e.kind === "message").map((e) => e.body);
  expect(said.join("")).toContain("hello from the fake agent");

  // Every state change was also pushed on the runs topic, ending in the terminal state.
  await until(
    () =>
      runs.frames.some((frame) => {
        const msg = wsMessageSchema.parse(frame);
        return msg.type === "run" && msg.run.id === id && msg.run.state === "completed";
      }),
    "the completed run frame",
  );
  runs.close();

  // The agent and the sandbox around it must not outlive the run.
  await until(() => liveProcesses(MARKER) === 0, "the agent process to exit", 10_000);
});

test("C1-run-fake-say: unknown agent and bad body [phase:1] [slice:runs] [focus:2]", async () => {
  const server = await lazy.get();
  const me = api(server, admin);
  const unknown = await me.call("POST", "/api/runs", {
    body: { agentId: "nope", repo: repo.path(), prompt: "x" },
  });
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({ error: "unknown agent" });
  const bad = await me.call("POST", "/api/runs", {
    body: { agentId: "fake", repo: "rel", prompt: "x" },
  });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ error: "invalid body" });
});
