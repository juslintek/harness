import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { listRunEvents } from "../logs/api";
import { probeQuota } from "../usage/api";
import {
  getRun,
  HaltedError,
  isHalted,
  killRun,
  listRuns,
  onRunEvent,
  recoverRuns,
  refreshAcpModels,
  setHalted,
  startRun,
  UnknownAgent,
  waitForRun,
} from "./api";
import { agentPid, cleanup, fakeDeps, fixture, gone, makeDir, transcript } from "./manager-kit";
import { insertRun, markRunning } from "./runs-repo";

afterAll(cleanup);

const input = (repo: string): { agentId: string; repo: string; prompt: string } => ({
  agentId: "fake",
  repo,
  prompt: "go",
});

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(25);
  }
}

test("a say script completes inside srt, keeps the branch and revokes the token", async () => {
  const x = fixture();
  const seen: string[] = [];
  const off = onRunEvent((_id, e) => seen.push(e.kind));
  const id = await startRun(x.db, fakeDeps(x, [{ say: "hello" }]), input(x.repo));
  expect(getRun(x.db, id)?.state).toBe("running");
  const row = await waitForRun(id);
  off();
  expect(row.state).toBe("completed");
  expect(row.branch).toBe(`harness/${id}`);
  expect(row.worktree).toBe(`${x.home}/worktrees/${id}`);
  const branch = Bun.spawnSync(["git", "rev-parse", "--verify", `harness/${id}`], { cwd: x.repo });
  expect(branch.exitCode).toBe(0);
  expect(transcript(x, id)).toBe("hello");
  expect(listRunEvents(x.db, id).some((e) => e.kind === "run")).toBe(true);
  expect(seen).toContain("message");
  const tokens = x.db
    .query<{ live: number; total: number }, [string]>(
      "SELECT count(*) FILTER (WHERE revoked_at IS NULL) AS live, count(*) AS total FROM run_tokens WHERE run_id = ?",
    )
    .get(id);
  expect(tokens).toEqual({ live: 0, total: 1 });
  expect(gone(agentPid(x, id))).toBe(true);
  expect(listRuns(x.db).map((r) => r.id)).toContain(id);
});

test("killRun during hang ends killed and the agent process is gone", async () => {
  const x = fixture();
  const id = await startRun(x.db, fakeDeps(x, [{ say: "up" }, { hang: true }]), input(x.repo));
  await until(() => transcript(x, id).includes("up"));
  expect(killRun(x.db, id)).toBe(true);
  const row = await waitForRun(id);
  expect(row.state).toBe("killed");
  expect(row.reason).toBe("killed_by_user");
  expect(gone(agentPid(x, id))).toBe(true);
  expect(killRun(x.db, id)).toBe(false);
});

test("setHalted(true) refuses new runs and kills live ones", async () => {
  const x = fixture();
  const id = await startRun(x.db, fakeDeps(x, [{ say: "up" }, { hang: true }]), input(x.repo));
  await until(() => transcript(x, id).includes("up"));
  setHalted(x.db, true);
  expect(isHalted(x.db)).toBe(true);
  await expect(startRun(x.db, fakeDeps(x, []), input(x.repo))).rejects.toBeInstanceOf(HaltedError);
  const row = await waitForRun(id);
  expect([row.state, row.reason]).toEqual(["killed", "halted"]);
  expect(gone(agentPid(x, id))).toBe(true);
});

test("the circuit breaker kills a run that floods events", async () => {
  const x = fixture();
  // Text chunks are coalesced into one message event, so permission asks are what floods.
  const ask = { ask: { command: "rm -rf ~" } };
  const script = [...Array.from({ length: 8 }, () => ask), { hang: true }];
  const deps = fakeDeps(x, script, { breaker: { maxEventsPerMinute: 3, maxTokens: 1_000_000 } });
  const id = await startRun(x.db, deps, input(x.repo));
  const row = await waitForRun(id);
  expect([row.state, row.reason]).toEqual(["killed", "circuit_breaker"]);
  expect(gone(agentPid(x, id))).toBe(true);
});

test("recoverRuns fails runs left running and expires pending approvals", () => {
  const x = fixture();
  const id = Bun.randomUUIDv7();
  insertRun(x.db, { id, taskId: null, agentId: "fake", model: null, repo: x.repo, prompt: "p" });
  markRunning(x.db, id);
  const now = Date.now();
  x.db.run(
    "INSERT INTO approvals (id, run_id, action, l1, status, created_at, expires_at) VALUES ('ap1', ?, '{}', '{}', 'pending', ?, ?)",
    [id, now, now + 600_000],
  );
  recoverRuns(x.db);
  expect(getRun(x.db, id)).toMatchObject({ state: "failed", reason: "harness_restart" });
  const status = x.db.query<{ status: string }, []>(
    "SELECT status FROM approvals WHERE id = 'ap1'",
  );
  expect(status.get()?.status).toBe("expired");
});

test("a directory that is not a git repo fails the run", async () => {
  const x = fixture();
  const id = await startRun(x.db, fakeDeps(x, []), input(makeDir()));
  const row = await waitForRun(id);
  expect([row.state, row.reason]).toEqual(["failed", "not_a_git_repo"]);
  expect(row.worktree).toBeNull();
});

test("an unknown agent is refused before any row is written", async () => {
  const x = fixture();
  const before = listRuns(x.db).length;
  await expect(
    startRun(x.db, fakeDeps(x, []), { ...input(x.repo), agentId: "nope" }),
  ).rejects.toBeInstanceOf(UnknownAgent);
  expect(listRuns(x.db).length).toBe(before);
});

test("a halt that lands while the launch is being prepared spawns nothing", async () => {
  const x = fixture();
  const deps = fakeDeps(x, [{ say: "never" }]);
  const agentEnv = deps.agentEnv;
  // agentEnv runs inside createLaunch, after the run is registered and before any spawn.
  deps.agentEnv = (runDir) => {
    setHalted(x.db, true);
    return agentEnv?.(runDir) ?? {};
  };
  const id = await startRun(x.db, deps, input(x.repo));
  const row = await waitForRun(id);
  expect([row.state, row.reason]).toEqual(["killed", "halted"]);
  expect(existsSync(join(x.home, "runs", id, "tmp", "pid"))).toBe(false);
  expect(transcript(x, id)).toBe("");
});

test("context fill reported mid-run trips the token cap", async () => {
  const x = fixture();
  const script = [{ usageUpdate: 40 }, { usageUpdate: 40 }, { usageUpdate: 40 }, { hang: true }];
  const deps = fakeDeps(x, script, { breaker: { maxEventsPerMinute: 1000, maxTokens: 100 } });
  const id = await startRun(x.db, deps, input(x.repo));
  const row = await waitForRun(id);
  expect([row.state, row.reason]).toEqual(["killed", "circuit_breaker"]);
  expect(gone(agentPid(x, id))).toBe(true);
});

test("quota readings land on the claude provider row", async () => {
  const x = fixture();
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const usage = {
    inputTokens: 1,
    outputTokens: 1,
    rateLimit: { fiveHour: 0.25, sevenDay: 0.5, resetsAt },
  };
  const id = await startRun(x.db, fakeDeps(x, [{ usage }]), input(x.repo));
  expect((await waitForRun(id)).state).toBe("completed");
  const rows = (await probeQuota(x.db)).filter((q) => q.provider === "claude");
  expect(rows.map((q) => [q.window, q.usedPercent])).toEqual([
    ["five_hour", 25],
    ["seven_day", 50],
  ]);
  expect((await probeQuota(x.db)).some((q) => q.provider === "anthropic")).toBe(false);
});

test("refreshAcpModels reads the model option from session/new under srt and cleans up", async () => {
  const x = fixture();
  const deps = fakeDeps(x, []);
  const spec = deps.resolveSpec?.("fake");
  if (!spec) throw new Error("fake spec missing");
  expect(await refreshAcpModels(deps, spec)).toEqual([
    { id: "fake-a", name: "Fake A" },
    { id: "fake-b", name: "fake-b" },
  ]);
  const left = Bun.spawnSync(["ls", join(x.home, "model-probes")])
    .stdout.toString()
    .trim();
  expect(left).toBe("");
});
