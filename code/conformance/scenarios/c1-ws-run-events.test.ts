import { afterAll, expect, test } from "bun:test";
import { wsMessageSchema } from "../../src/shared/realtime";
import { api, headersFor, openWs, until } from "../kit/client";
import { fakeAgent, lazyRepo, liveProcesses } from "../kit/fixtures";
import { type SeededSession, seedSession } from "../kit/seed";
import { lazyBoot } from "../kit/server";

const MARKER = `conformance-ws-${crypto.randomUUID()}`;
const repo = lazyRepo();
let admin: SeededSession;
let spare: SeededSession;
let member: SeededSession;

const lazy = lazyBoot({
  seed: (db) => {
    admin = seedSession(db, { admin: true, stepUp: true });
    spare = seedSession(db, { admin: true });
    member = seedSession(db);
  },
  // The agent talks, then hangs until the run is killed, so the socket is open before the run ends.
  agents: [fakeAgent("fake", [{ say: "still here" }, { hang: true }], MARKER)],
});
afterAll(async () => {
  try {
    await lazy.stop();
  } finally {
    repo.remove();
  }
});

test("C1-ws-run-events: run events arrive on the run topic [phase:1] [slice:realtime] [focus:2] [race:ws-vs-run]", async () => {
  const server = await lazy.get();
  const me = api(server, admin);
  const { id } = await me.json<{ id: string }>("POST", "/api/runs", {
    body: { agentId: "fake", repo: repo.path(), prompt: "wait" },
  });
  await until(async () => {
    const detail = await me.json<{ run: { state: string } }>("GET", `/api/runs/${id}`);
    return detail.run.state === "running";
  }, "the run to start");

  // The probe is only meaningful if it sees the agent while it is alive.
  await until(() => liveProcesses(MARKER) > 0, "the agent process");
  const socket = await openWs(server, `run:${id}`, admin);
  const kill = await me.call("POST", `/api/runs/${id}/kill`);
  expect(kill.status).toBe(200);
  await until(() => socket.frames.length > 0, "a run event frame");
  for (const frame of socket.frames) {
    const msg = wsMessageSchema.parse(frame);
    expect(msg.type).toBe("event");
    if (msg.type === "event") expect(msg.runId).toBe(id);
  }
  socket.close();
  await until(() => liveProcesses(MARKER) === 0, "the killed agent to exit", 10_000);
});

test("C1-ws-run-events: topic and admin checks [phase:1] [slice:realtime] [focus:2]", async () => {
  const server = await lazy.get();
  // A refused upgrade is an ordinary JSON answer, so these need no socket.
  const upgrade = (topic: string, who: SeededSession): Promise<Response> =>
    fetch(`${server.base}/ws?topic=${encodeURIComponent(topic)}`, {
      headers: headersFor(server, who),
    });
  const uuid = "0190c0de-0000-7000-8000-000000000000";
  const bad = await upgrade("everything", admin);
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ error: "invalid topic" });
  const denied = await upgrade(`run:${uuid}`, member);
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: "forbidden" });
  const noOrigin = await fetch(`${server.base}/ws?topic=runs`, {
    headers: headersFor(server, admin, { origin: null }),
  });
  expect(noOrigin.status).toBe(403);
});

test("C1-ws-run-events: a revoked session is closed with 4401 [phase:1] [slice:realtime] [focus:2]", async () => {
  const server = await lazy.get();
  const socket = await openWs(server, "runs", spare);
  const out = await api(server, spare).call("POST", "/api/auth/logout");
  expect(out.status).toBe(200);
  expect(await socket.closed).toBe(4401);
});
