import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../http";
import { fakeCliSpec } from "../../test-support/agents-kit";
import { sessionHeaders } from "../../test-support/app-kit";
import { getRun, waitForRun } from "./api";
import { addAccount, cleanup, fixture } from "./manager-kit";

afterAll(cleanup);

test("POST /api/runs accepts accountId and returns 404/409 for unknown or unavailable account", async () => {
  const f = fixture();
  const acctHome = join(f.home, "accounts", "b");
  mkdirSync(acctHome, { recursive: true });
  const active = addAccount(f.db, "claude", acctHome, "active");
  const disabled = addAccount(f.db, "claude", acctHome, "disabled");
  const codexAcct = addAccount(f.db, "codex", acctHome, "active");

  const port = 4199;
  const origin = `http://localhost:${port}`;
  const app = createApp({
    db: f.db,
    home: f.home,
    port,
    rp: { id: "localhost", name: "Harness", origin },
    instanceId: "i",
    version: "1",
    runDeps: {
      home: f.home,
      port,
      resolveSpec: (id) => (id === "claude" ? fakeCliSpec("claude") : null),
      lane: async () => ({
        stopReason: "end_turn",
        text: "",
        usage: [],
        error: null,
        sessionId: null,
      }),
    },
  });
  const { headers } = await sessionHeaders(f.db, { admin: true, stepUp: true, origin });
  const post = (body: object) =>
    app.request("/api/runs", { method: "POST", headers, body: JSON.stringify(body) });

  const base = { agentId: "claude", repo: f.repo, prompt: "go" };

  const ok = await post({ ...base, accountId: active });
  expect(ok.status).toBe(201);
  const { id } = (await ok.json()) as { id: string };
  await waitForRun(id);
  expect(getRun(f.db, id)?.accountId).toBe(active);

  const unknown = await post({ ...base, accountId: "does-not-exist" });
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({ error: "account unavailable: unknown" });

  const off = await post({ ...base, accountId: disabled });
  expect(off.status).toBe(409);
  expect(await off.json()).toEqual({ error: "account unavailable: disabled" });

  const wrongRuntime = await post({ ...base, accountId: codexAcct });
  expect(wrongRuntime.status).toBe(409);
  expect(await wrongRuntime.json()).toEqual({
    error: "account unavailable: belongs to another runtime",
  });
});
