import { afterAll, expect, test } from "bun:test";
import { type WsMessage, wsMessageSchema } from "../shared/runs";
import { checkAction, decideApproval, listApprovals } from "./features/guard/api";
import { killRun, startRun, waitForRun } from "./features/runtimes/api";
import {
  agentPid,
  cleanup,
  type Fixture,
  fakeDeps,
  fixture,
  gone,
} from "./features/runtimes/manager-kit";
import { createApp } from "./http";
import { wireRealtime } from "./realtime";
import { adminHeaders, listenDeferred, openSocket, until } from "./test-support/app-kit";

afterAll(cleanup);

const SECRET = "r".repeat(64);

function collect(ws: WebSocket): WsMessage[] {
  const seen: WsMessage[] = [];
  ws.onmessage = (e) => seen.push(wsMessageSchema.parse(JSON.parse(String(e.data))));
  return seen;
}

async function boot(x: Fixture): Promise<{
  port: number;
  deps: ReturnType<typeof fakeDeps>;
  headers: Record<string, string>;
  stop: () => Promise<void>;
}> {
  const { server, port, attach } = listenDeferred();
  const deps = fakeDeps(x, [{ say: "working" }, { hang: true }], { port });
  const app = createApp({
    db: x.db,
    home: x.home,
    port,
    secret: SECRET,
    instanceId: "i",
    version: "1",
    runDeps: deps,
  });
  attach(app);
  const off = wireRealtime(x.db, server);
  const headers = await adminHeaders(app, port, SECRET);
  return {
    port,
    deps,
    headers,
    stop: async () => {
      off();
      await server.stop(true);
    },
  };
}

// The guard asks, the human denies: both sockets must hear about it via the real listeners.
async function askAndDeny(x: Fixture, runId: string): Promise<void> {
  const scope = { root: x.repo, home: "/home/u", defaultBranch: "main" };
  const outcome = checkAction(
    x.db,
    { id: runId, prompt: "go", scope },
    { kind: "fetch", paths: [] },
    { approvalTimeoutMs: 60_000 },
  );
  await until(() => listApprovals(x.db, "pending").length === 1);
  const [row] = listApprovals(x.db, "pending");
  expect(decideApproval(x.db, row?.id ?? "", "deny", "admin")).toBe(true);
  expect((await outcome).verdict).toBe("deny");
}

test("approval changes and run events reach authenticated sockets through the real listeners", async () => {
  const x = fixture();
  const app = await boot(x);
  try {
    const runId = await startRun(x.db, app.deps, { agentId: "fake", repo: x.repo, prompt: "go" });
    const base = `ws://127.0.0.1:${app.port}/ws?topic=`;
    const approvals = collect(await openSocket(`${base}approvals`, app.headers));
    const runTopic = collect(await openSocket(`${base}run:${runId}`, app.headers));
    const runs = collect(await openSocket(`${base}runs`, app.headers));

    await askAndDeny(x, runId);
    const statuses = (): string[] =>
      approvals.flatMap((m) => (m.type === "approval" ? [m.approval.status] : []));
    await until(() => statuses().includes("pending") && statuses().includes("denied"));
    await until(() => runTopic.some((m) => m.type === "event" && m.event.kind === "approval"));

    killRun(x.db, runId);
    await until(() => runTopic.some((m) => m.type === "event" && m.event.kind === "run"));
    await until(() => runs.some((m) => m.type === "run" && m.run.state === "killed"));
    await waitForRun(runId);
    expect(gone(agentPid(x, runId))).toBe(true);
  } finally {
    await app.stop();
  }
});
