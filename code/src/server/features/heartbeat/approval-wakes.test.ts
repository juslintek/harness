import { expect, test } from "bun:test";
import type { ApprovalView } from "../../../shared/runs";
import { onApprovalResolved } from "./approval-wakes";
import { setup, wakes } from "./kit";

function world(state: string, withMember = true) {
  const k = setup();
  const dev = k.agent("dev");
  const task = k.task("ship");
  const runId = Bun.randomUUIDv7();
  k.db.run(
    "INSERT INTO runs (id, task_id, member_id, agent_id, repo, prompt, state, created_at) VALUES (?, ?, ?, 'fake', '/r', 'p', ?, ?)",
    [runId, task.id, withMember ? dev.id : null, state, Date.now()],
  );
  const approval = (
    status: ApprovalView["status"],
    decidedBy: string | null = "user:u1",
  ): ApprovalView => ({
    id: "a1",
    runId,
    command: `rm -rf ${"x".repeat(300)}`,
    reason: null,
    status,
    decidedBy,
    createdAt: 0,
    expiresAt: 0,
    decidedAt: 1,
  });
  return { k, dev, task, approval };
}

test("approved after the run was killed wakes the member with the status and command", () => {
  const { k, dev, task, approval } = world("killed");
  expect(onApprovalResolved(k.db, approval("approved"))).toBe(true);
  const rows = wakes(k.db, dev.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.reason).toBe("approval_resolved");
  expect(rows[0]?.detail).toContain("approved");
  expect(rows[0]?.detail).toContain("rm -rf");
  expect(rows[0]?.detail).not.toContain("x".repeat(201));
  const stored = k.db.query<{ task_id: string }, []>("SELECT task_id FROM wakeups").get();
  expect(stored?.task_id).toBe(task.id);
});

test("resolved while the run is still running wakes nobody", () => {
  const { k, dev, approval } = world("running");
  expect(onApprovalResolved(k.db, approval("approved"))).toBe(false);
  expect(wakes(k.db, dev.id)).toHaveLength(0);
});

test("a pending approval wakes nobody", () => {
  const { k, dev, approval } = world("killed");
  expect(onApprovalResolved(k.db, approval("pending"))).toBe(false);
  expect(wakes(k.db, dev.id)).toHaveLength(0);
});

test("a run without a member wakes nobody", () => {
  const { k, approval } = world("failed", false);
  expect(onApprovalResolved(k.db, approval("approved"))).toBe(false);
  expect(k.db.query("SELECT 1 FROM wakeups").all()).toHaveLength(0);
});

test("denied and expired wake too", () => {
  for (const status of ["denied", "expired"] as const) {
    const { k, dev, approval } = world("cancelled");
    expect(onApprovalResolved(k.db, approval(status, null))).toBe(true);
    expect(wakes(k.db, dev.id)[0]?.detail).toContain(status);
  }
});

test("two resolution events for one approval leave one wake row", () => {
  const { k, dev, approval } = world("killed");
  onApprovalResolved(k.db, approval("approved"));
  onApprovalResolved(k.db, approval("approved"));
  expect(wakes(k.db, dev.id)).toHaveLength(1);
});

test("the member who decided is not woken by their own decision", () => {
  const { k, dev, approval } = world("killed");
  expect(onApprovalResolved(k.db, approval("approved", `agent:${dev.id}`))).toBe(false);
  expect(wakes(k.db, dev.id)).toHaveLength(0);
});
