import type { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { healthSchema } from "../shared/health";
import { migrate, openDb } from "./db/db";
import { migrations } from "./db/migrations";
import { mintRunToken } from "./features/mcp/api";
import { createApp } from "./http";
import { sessionHeaders } from "./test-support/app-kit";

const PORT = 4100;
const ORIGIN = `http://localhost:${PORT}`;
const LOOPBACK = { host: `127.0.0.1:${PORT}` };
let db: Database;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db, migrations);
  app = createApp({
    db,
    home: "/unused",
    port: PORT,
    rp: { id: "localhost", name: "Harness", origin: ORIGIN },
    instanceId: "abc",
    version: "1.2.3",
  });
});

const send = (
  path: string,
  init: RequestInit = {},
  headers: Record<string, string> = {},
): Response | Promise<Response> =>
  app.request(path, { ...init, headers: { host: `localhost:${PORT}`, ...headers } });

async function loginCookie(): Promise<string> {
  const { headers } = await sessionHeaders(db, { admin: true, stepUp: true });
  return headers.cookie ?? "";
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const JSON_HEADER = { "content-type": "application/json" };

test("health stays public and keeps security headers", async () => {
  const res = await send("/api/health");
  expect(res.status).toBe(200);
  expect(healthSchema.parse(await res.json()).instanceId).toBe("abc");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});

test("/api/agents without cookie is 401, with a run bearer token still 401", async () => {
  expect((await send("/api/agents")).status).toBe(401);
  const token = mintRunToken(db, "r1", ["report", "guard_hook"]);
  const bearer = { authorization: `Bearer ${token}` };
  expect((await send("/api/agents", {}, bearer)).status).toBe(401);
  expect((await send("/api/usage", {}, bearer)).status).toBe(401);
});

test("the old secret login is gone", async () => {
  expect((await send("/login?k=anything")).status).toBe(404);
});

test("cookie opens the api, a forged cookie does not", async () => {
  const cookie = await loginCookie();
  expect((await send("/api/agents/ollaya", {}, { cookie })).status).toBe(200);
  expect((await send("/api/agents", {}, { cookie: "harness_session=forged" })).status).toBe(401);
});

test("mutating requests need the configured Origin", async () => {
  const cookie = await loginCookie();
  const init = post({ enabled: true });
  const url = "/api/agents/claude/link";
  const base = { ...JSON_HEADER, cookie };
  expect((await send(url, init, { ...base, origin: "http://evil.test" })).status).toBe(403);
  expect((await send(url, init, base)).status).toBe(403);
  expect((await send(url, init, { ...base, origin: ORIGIN })).status).toBe(200);
  expect((await send(url, init, { ...base, origin: `http://127.0.0.1:${PORT}` })).status).toBe(403);
});

test("foreign Host is 403 everywhere, including health and the auth endpoints", async () => {
  for (const host of ["evil.test", `127.0.0.1:${PORT}`]) {
    for (const path of ["/api/health", "/api/auth/me", "/api/agents"]) {
      const expected = host.startsWith("127") && path === "/api/health" ? 200 : 403;
      expect((await app.request(path, { headers: { host } })).status).toBe(expected);
    }
  }
});

test("GET / on the loopback IP redirects to the configured origin", async () => {
  const res = await send("/", {}, LOOPBACK);
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(ORIGIN);
});

test("guard hook accepts only a matching guard_hook run token and logs a guard event", async () => {
  const body = { runId: "r1", verdict: "deny", rule: "rm-rf", command: "rm -rf /" };
  const url = "/api/guard/hook";
  expect((await send(url, post(body), { ...JSON_HEADER, ...LOOPBACK })).status).toBe(401);
  const call = (token: string, payload: unknown): Response | Promise<Response> =>
    send(url, post(payload), { ...JSON_HEADER, ...LOOPBACK, authorization: `Bearer ${token}` });
  expect((await call(mintRunToken(db, "r1", ["report"]), body)).status).toBe(403);
  const hook = mintRunToken(db, "r1", ["guard_hook"]);
  expect((await call(hook, { ...body, runId: "r2" })).status).toBe(403);
  expect((await call(hook, { runId: "r1" })).status).toBe(400);
  expect((await call(hook, body)).status).toBe(200);
  expect(
    db.query("SELECT kind, source, guard_verdict, guard_rule, command, run_id FROM events").all(),
  ).toEqual([
    {
      kind: "guard",
      source: "hook",
      guard_verdict: "deny",
      guard_rule: "rm-rf",
      command: "rm -rf /",
      run_id: "r1",
    },
  ]);
});

test("a run token opens nothing next to the hook path", async () => {
  const hook = mintRunToken(db, "r1", ["guard_hook"]);
  expect((await send("/api/guard/other", {}, { authorization: `Bearer ${hook}` })).status).toBe(
    401,
  );
});

test("/mcp without token is 401 through the app, a report token logs a message", async () => {
  expect((await send("/mcp", { method: "POST", body: "{}" }, LOOPBACK)).status).toBe(401);
  const token = mintRunToken(db, "r9", ["report"]);
  const rpc = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "report", arguments: { text: "halfway" } },
  };
  const res = await send("/mcp", post(rpc), {
    ...LOOPBACK,
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  expect(res.status).toBe(200);
  expect(db.query("SELECT kind, source, run_id FROM events").all()).toEqual([
    { kind: "message", source: "mcp", run_id: "r9" },
  ]);
});

test("search and usage validate their query", async () => {
  const cookie = await loginCookie();
  expect((await send("/api/search", {}, { cookie })).status).toBe(400);
  expect((await send("/api/search?q=hello", {}, { cookie })).status).toBe(200);
  expect((await send("/api/usage?by=bogus", {}, { cookie })).status).toBe(400);
  expect((await send("/api/usage?by=agent&since=0", {}, { cookie })).status).toBe(200);
  expect((await send("/api/quota", {}, { cookie })).status).toBe(200);
});
