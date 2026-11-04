import { afterAll, expect, test } from "bun:test";
import type { AgentSpec } from "../agents/api";
import { listRunEvents, readBody } from "../logs/api";
import type { Adapter, RunOutcome } from "./adapter";
import { shutdownRuns, startRun, waitForRun } from "./api";
import { cleanup, fixture } from "./manager-kit";

afterAll(cleanup);

const spec: AgentSpec = {
  id: "stub",
  name: "Stub",
  lane: "api",
  bin: "",
  args: [],
  versionArgs: [],
  loginProbe: null,
  loginArgs: null,
  modeOption: null,
  egress: [],
  stateWrite: [],
  weakerNetworkIsolation: false,
  claudeMeta: false,
  mcp: true,
};

const done: RunOutcome = {
  stopReason: "end_turn",
  text: "",
  error: null,
  sessionId: null,
  usage: [],
};

function setup(lane: Adapter): { x: ReturnType<typeof fixture>; start: () => Promise<string> } {
  const x = fixture();
  const deps = { home: x.home, port: 1, resolveSpec: () => spec, lane };
  return { x, start: () => startRun(x.db, deps, { agentId: "stub", repo: x.repo, prompt: "go" }) };
}

function endEvents(x: ReturnType<typeof fixture>, id: string): string[] {
  return listRunEvents(x.db, id)
    .filter((e) => e.kind === "run")
    .map((e) => readBody(x.db, e.rowid) ?? "");
}

test("a lane that returns after the shutdown grace does not end the run a second time", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { x, start } = setup(async () => {
    await gate;
    return done;
  });
  const id = await start();
  await shutdownRuns(x.db, 0);
  release();
  const row = await waitForRun(id);
  expect([row.state, row.reason]).toEqual(["killed", "harness_shutdown"]);
  expect(endEvents(x, id)).toEqual(["killed: harness_shutdown"]);
});

test("a finalize that throws before the run is marked ended is retried and ends the run", async () => {
  const { x, start } = setup(() => Promise.resolve(done));
  x.db.run(
    "CREATE TRIGGER busy BEFORE UPDATE OF state ON runs WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'database is locked'); END",
  );
  const id = await start();
  const row = await waitForRun(id);
  expect([row.state, row.reason]).toEqual(["failed", "internal_error"]);
  expect(row.endedAt).not.toBeNull();
});
