import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { wsMessageSchema } from "../shared/realtime";
import { approvalViewSchema, runDetailSchema } from "../shared/runs";
import { migrate, openDb } from "./db/db";
import { migrations } from "./db/migrations";
import { appendEvent } from "./features/logs/api";
import { createApp, MAX_REQUEST_BODY_BYTES } from "./http";
import { wireRealtime } from "./realtime";
import { listenDeferred, openSocket, sessionHeaders } from "./test-support/app-kit";

const RUN_ID = "0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
let db: Database;
let port: number;
let server: ReturnType<typeof listenDeferred>["server"];
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db, migrations);
  const listener = listenDeferred();
  server = listener.server;
  port = listener.port;
  app = createApp({
    db,
    home: "/unused",
    port,
    rp: { id: "localhost", name: "Harness", origin: `http://localhost:${port}` },
    instanceId: "abc",
    version: "1",
    runDeps: { home: "/unused", port, resolveSpec: () => null },
  });
  listener.attach(app);
});
afterEach(async () => {
  await server.stop(true);
});

const cookie = async (): Promise<Record<string, string>> =>
  (await sessionHeaders(db, { admin: true, stepUp: true, origin: `http://localhost:${port}` }))
    .headers;

async function call(path: string, method: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: await cookie(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function insertRun(id: string): void {
  db.run(
    "INSERT INTO runs (id, agent_id, repo, prompt, state, created_at) VALUES (?, 'fake', '/r', 'p', 'running', ?)",
    [id, Date.now()],
  );
}

function insertApproval(id: string, status = "pending"): void {
  const action = JSON.stringify({ command: "rm -rf build", paths: [] });
  db.run(
    "INSERT INTO approvals (id, run_id, action, l1, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      RUN_ID,
      action,
      JSON.stringify({ reason: "deletes files" }),
      status,
      1,
      Date.now() + 60_000,
    ],
  );
}

test("POST /api/runs: bad body 400, relative repo 400, unknown agent 404, halted 409", async () => {
  const good = { agentId: "nope", repo: "/tmp/r", prompt: "go" };
  expect((await call("/api/runs", "POST", { agentId: "x" })).status).toBe(400);
  expect((await call("/api/runs", "POST", { ...good, repo: "rel/path" })).status).toBe(400);
  expect((await call("/api/runs", "POST", { ...good, prompt: "" })).status).toBe(400);
  expect((await call("/api/runs", "POST", good)).status).toBe(404);
  expect((await call("/api/halt", "POST", { halted: true })).status).toBe(200);
  expect(await (await call("/api/halt", "GET")).json()).toEqual({ halted: true });
  expect((await call("/api/runs", "POST", good)).status).toBe(409);
  expect((await call("/api/halt", "POST", { halted: "yes" })).status).toBe(400);
});

test("starting or killing a run needs a fresh step-up", async () => {
  const { headers } = await sessionHeaders(db, {
    admin: true,
    stepUp: false,
    origin: `http://localhost:${port}`,
  });
  const good = { agentId: "nope", repo: "/tmp/r", prompt: "go" };
  for (const [path, body] of [
    ["/api/runs", good],
    ["/api/runs/nope/kill", {}],
  ] as const) {
    const res = await app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
    expect([path, res.status, await res.json()]).toEqual([
      path,
      403,
      { error: "step_up_required" },
    ]);
  }
});

test("kill of an unknown run is 404", async () => {
  expect((await call("/api/runs/nope/kill", "POST")).status).toBe(404);
});

test("run detail rows parse with the shared schema, and ?after pages events", async () => {
  insertRun(RUN_ID);
  appendEvent(db, { runId: RUN_ID, kind: "message", body: "hello <b>world</b>" });
  appendEvent(db, { runId: RUN_ID, kind: "guard", command: "ls", guardVerdict: "allow" });
  const first = runDetailSchema.parse(await (await call(`/api/runs/${RUN_ID}`, "GET")).json());
  expect(first.events.map((e) => e.kind)).toEqual(["message", "guard"]);
  expect(first.events[0]?.body).toBe("hello <b>world</b>");
  const list = await (await call("/api/runs", "GET")).json();
  expect(list).toHaveLength(1);
  const rest = runDetailSchema.parse(
    await (await call(`/api/runs/${RUN_ID}?after=${first.events[0]?.rowid}`, "GET")).json(),
  );
  expect(rest.events.map((e) => e.kind)).toEqual(["guard"]);
  expect((await call("/api/runs/missing", "GET")).status).toBe(404);
  expect((await call(`/api/runs/${RUN_ID}?after=x`, "GET")).status).toBe(400);
});

test("approvals: raw command shown, decide 200 then 409, unknown 404, bad input 400", async () => {
  insertApproval("a1");
  const pending = await (await call("/api/approvals?status=pending", "GET")).json();
  expect(approvalViewSchema.parse(pending[0]).command).toBe("rm -rf build");
  expect((await call("/api/approvals?status=bogus", "GET")).status).toBe(400);
  expect((await call("/api/approvals/a1", "POST", { decision: "maybe" })).status).toBe(400);
  const done = await call("/api/approvals/a1", "POST", { decision: "approve" });
  expect(done.status).toBe(200);
  expect(approvalViewSchema.parse(await done.json()).status).toBe("approved");
  expect(db.query("SELECT decided_by FROM approvals WHERE id = 'a1'").get()).toEqual({
    decided_by: expect.stringMatching(/^user:/),
  });
  expect((await call("/api/approvals/a1", "POST", { decision: "deny" })).status).toBe(409);
  expect((await call("/api/approvals/zzz", "POST", { decision: "deny" })).status).toBe(404);
});

test("approval and run routes need a session cookie", async () => {
  const host = { host: `localhost:${port}` };
  for (const path of ["/api/runs", "/api/approvals", "/api/halt"]) {
    expect((await app.request(path, { headers: host })).status).toBe(401);
  }
});

test("/ws without cookie or with a foreign origin is rejected before any upgrade", async () => {
  const host = { host: `localhost:${port}` };
  const origin = `http://localhost:${port}`;
  expect((await app.request("/ws?topic=runs", { headers: { ...host, origin } })).status).toBe(401);
  const headers = await cookie();
  const evil = { ...headers, origin: "http://evil.test" };
  expect((await app.request("/ws?topic=runs", { headers: evil })).status).toBe(403);
  const { origin: _drop, ...noOrigin } = headers;
  expect((await app.request("/ws?topic=runs", { headers: noOrigin })).status).toBe(403);
  const token = { ...host, origin, authorization: "Bearer abc" };
  expect((await app.request("/ws?topic=runs", { headers: token })).status).toBe(401);
});

test("real socket: bad cookie rejected, admin cookie receives approval and run messages", async () => {
  const off = wireRealtime(db, server);
  try {
    const headers = await cookie();
    await expect(
      openSocket(`ws://127.0.0.1:${port}/ws?topic=runs`, {
        ...headers,
        cookie: "harness_session=bad",
      }),
    ).rejects.toThrow();
    await expect(openSocket(`ws://127.0.0.1:${port}/ws?topic=bogus`, headers)).rejects.toThrow();
    const ws = await openSocket(`ws://127.0.0.1:${port}/ws?topic=approvals`, headers);
    const got = new Promise<string>((resolve) => {
      ws.onmessage = (m) => resolve(String(m.data));
    });
    insertApproval("a2");
    server.publish(
      "approvals",
      JSON.stringify({
        type: "approval",
        approval: {
          id: "a2",
          runId: RUN_ID,
          command: "x",
          reason: null,
          status: "pending",
          decidedBy: null,
          createdAt: 1,
          expiresAt: 2,
          decidedAt: null,
        },
      }),
    );
    expect(wsMessageSchema.parse(JSON.parse(await got)).type).toBe("approval");
    ws.close();
  } finally {
    off();
  }
});

test("a body over the limit is rejected on /mcp and the guard hook before any handler runs", async () => {
  const body = "x".repeat(MAX_REQUEST_BODY_BYTES + 1);
  for (const path of ["/mcp", "/api/guard/hook"]) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body });
    expect(res.status).toBe(413);
  }
});
