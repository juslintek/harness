import { afterAll, expect, test } from "bun:test";
import { listRunEvents, readBody } from "../logs/api";
import { mintRunToken, verifyRunToken } from "../mcp/api";
import { getRun, recoverRuns, shutdownRuns, startRun, waitForRun } from "./api";
import { agentPid, cleanup, fakeDeps, fixture, gone, transcript } from "./manager-kit";
import { pidIdentity } from "./orphans";
import { insertRun, markRunning, setPid } from "./runs-repo";

afterAll(cleanup);

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(25);
  }
}

function pidOf(f: ReturnType<typeof fixture>, runId: string): number | null {
  return (
    f.db.query<{ pid: number | null }, [string]>("SELECT pid FROM runs WHERE id = ?").get(runId)
      ?.pid ?? null
  );
}

test("shutdownRuns kills the agent group, ends the run killed and revokes its token", async () => {
  const x = fixture();
  const deps = fakeDeps(x, [{ say: "up" }, { hang: true }]);
  const id = await startRun(x.db, deps, { agentId: "fake", repo: x.repo, prompt: "go" });
  await until(() => transcript(x, id).includes("up"));
  const pid = pidOf(x, id);
  expect(pid).not.toBeNull();
  await shutdownRuns(x.db, 5000);
  const row = await waitForRun(id);
  expect([row.state, row.reason]).toEqual(["killed", "harness_shutdown"]);
  const ends = listRunEvents(x.db, id).filter(
    (e) => e.kind === "run" && readBody(x.db, e.rowid)?.startsWith("killed"),
  );
  expect(ends).toHaveLength(1);
  expect(gone(agentPid(x, id))).toBe(true);
  const tokens = x.db
    .query<{ n: number }, [string]>("SELECT count(*) AS n FROM run_tokens WHERE run_id = ?")
    .get(id);
  expect(tokens?.n).toBe(0);
});

function orphan(x: ReturnType<typeof fixture>, label: string): { id: string; pid: number } {
  // The trailing `true` keeps sh from exec-ing sleep, so the label stays in the command line.
  const proc = Bun.spawn(["sh", "-c", "sleep 60; true", label], { detached: true });
  const id = Bun.randomUUIDv7();
  insertRun(x.db, { id, taskId: null, agentId: "fake", model: null, repo: x.repo, prompt: "p" });
  markRunning(x.db, id);
  setPid(x.db, id, proc.pid, pidIdentity(proc.pid));
  return { id, pid: proc.pid };
}

test("recoverRuns kills a surviving srt agent group, revokes its token and fails the run", async () => {
  const x = fixture();
  const { id, pid } = orphan(x, "srt-agent");
  const token = mintRunToken(x.db, id, ["report"]);
  expect(verifyRunToken(x.db, token)).not.toBeNull();
  recoverRuns(x.db);
  await until(() => gone(pid));
  expect(verifyRunToken(x.db, token)).toBeNull();
  expect(getRun(x.db, id)).toMatchObject({ state: "failed", reason: "harness_restart" });
});

test("recoverRuns leaves a pid alone when it no longer belongs to an srt process", async () => {
  const x = fixture();
  const { id, pid } = orphan(x, "unrelated");
  const token = mintRunToken(x.db, id, ["report"]);
  recoverRuns(x.db);
  await Bun.sleep(200);
  expect(gone(pid)).toBe(false);
  expect(verifyRunToken(x.db, token)).toBeNull();
  process.kill(-pid, "SIGKILL");
});
