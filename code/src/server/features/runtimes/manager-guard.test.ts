// Phase 1 gate proof: the real srt sandbox (L0) and the guard layers around a scripted agent.
import { afterAll, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decideApproval, listApprovals } from "../guard/api";
import { listRunEvents } from "../logs/api";
import { getRun, killRun, startRun, waitForRun } from "./api";
import {
  agentPid,
  cleanup,
  fakeDeps,
  firstSshEntry,
  fixture,
  gone,
  transcript,
} from "./manager-kit";

afterAll(cleanup);

const input = (repo: string): { agentId: string; repo: string; prompt: string } => ({
  agentId: "fake",
  repo,
  prompt: "go",
});

async function pendingApproval(x: ReturnType<typeof fixture>, runId: string): Promise<string> {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const hit = listApprovals(x.db, "pending").find((a) => a.runId === runId);
    if (hit) return hit.id;
    await Bun.sleep(25);
  }
  throw new Error("no pending approval appeared");
}

test("destructive asks are denied by L1 and srt blocks direct ~/.ssh reads and writes outside the worktree", async () => {
  const x = fixture();
  const canary = join(homedir(), `.harness-canary-${crypto.randomUUID()}`);
  try {
    const script = [
      { ask: { command: "rm -rf ~" } },
      { ask: { command: "cat ~/.ssh/id_ed25519" } },
      { readFile: firstSshEntry() },
      { writeFile: canary },
      { say: "done" },
    ];
    const id = await startRun(x.db, fakeDeps(x, script), input(x.repo));
    const row = await waitForRun(id);

    const l1Denies = listRunEvents(x.db, id).filter(
      (e) => e.kind === "guard" && e.guardLayer === "L1" && e.guardVerdict === "deny",
    );
    expect(l1Denies.map((e) => e.command)).toEqual(["rm -rf ~", "cat ~/.ssh/id_ed25519"]);

    expect(transcript(x, id)).toBe(
      "permission selected rejectpermission selected rejectreadFile error EPERMwriteFile error EPERMdone",
    );

    if (existsSync(canary)) {
      rmSync(canary);
      throw new Error(`srt let the agent write outside the worktree: ${canary}`);
    }
    expect(row.state).toBe("completed");
    expect(gone(agentPid(x, id))).toBe(true);
  } finally {
    if (existsSync(canary)) rmSync(canary);
  }
});

test("a git push waits for approval and the agent gets allow after approve", async () => {
  const x = fixture();
  const script = [{ ask: { command: "git push origin feature/x" } }, { say: "after" }];
  const id = await startRun(x.db, fakeDeps(x, script), input(x.repo));
  const approvalId = await pendingApproval(x, id);
  expect(getRun(x.db, id)?.state).toBe("running");
  expect(decideApproval(x.db, approvalId, "approve", "test")).toBe(true);
  const row = await waitForRun(id);
  expect(row.state).toBe("completed");
  expect(transcript(x, id)).toBe("permission selected allow-onceafter");
  expect(listApprovals(x.db, "approved").map((a) => a.id)).toEqual([approvalId]);
  expect(gone(agentPid(x, id))).toBe(true);
});

test("an approval nobody answers ends the run blocked with approval_timeout", async () => {
  const x = fixture();
  const script = [{ ask: { command: "git push origin feature/x" } }, { say: "after" }];
  const deps = fakeDeps(x, script, { approvalTimeoutMs: 200 });
  const row = await waitForRun(await startRun(x.db, deps, input(x.repo)));
  expect([row.state, row.reason]).toEqual(["blocked", "approval_timeout"]);
  expect(transcript(x, row.id)).toBe("permission selected rejectafter");
  expect(gone(agentPid(x, row.id))).toBe(true);
});

test("killing a run with a pending approval expires it instead of leaving a waiter", async () => {
  const x = fixture();
  const script = [{ ask: { command: "git push origin feature/x" } }, { say: "after" }];
  const id = await startRun(x.db, fakeDeps(x, script), input(x.repo));
  const approvalId = await pendingApproval(x, id);
  expect(killRun(x.db, id)).toBe(true);
  const row = await waitForRun(id);
  expect([row.state, row.reason]).toEqual(["killed", "killed_by_user"]);
  expect(listApprovals(x.db, "expired").map((a) => a.id)).toEqual([approvalId]);
  expect(decideApproval(x.db, approvalId, "approve", "late")).toBe(false);
  expect(gone(agentPid(x, id))).toBe(true);
});
