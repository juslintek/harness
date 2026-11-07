import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  checkAction,
  decideApproval,
  expireRunApprovals,
  findApproval,
  onApprovalChange,
} from "../guard/api";
import { recoverRuns } from "../runtimes/api";
import { setup, until, wakes } from "./kit";

function world() {
  const k = setup();
  const member = k.agent("dev");
  const runId = Bun.randomUUIDv7();
  k.db.run(
    "INSERT INTO runs (id, member_id, agent_id, repo, prompt, state, created_at) VALUES (?, ?, 'fake', '/r', 'p', 'running', ?)",
    [runId, member.id, Date.now()],
  );
  const ended = (): void => {
    k.db.run("UPDATE runs SET state = 'killed' WHERE id = ?", [runId]);
    expireRunApprovals(k.db, runId);
  };
  const pending = (timeoutMs: number) => {
    let id = "";
    const outcome = checkAction(
      k.db,
      { id: runId, prompt: "p", scope: { root: k.home, home: k.home, defaultBranch: "main" } },
      { kind: "execute", command: "git push origin feature/x", paths: [] },
      {
        approvalTimeoutMs: timeoutMs,
        onApprovalPending: (approvalId) => {
          id = approvalId;
        },
      },
    );
    expect(id).not.toBe("");
    return { id, outcome };
  };
  const close = (): void => {
    k.db.close();
    rmSync(k.home, { recursive: true, force: true });
  };
  return { k, member, runId, ended, pending, close };
}

test("a killed run releases its waiter but still expires and wakes once", async () => {
  const w = world();
  const stop = w.k.start();
  const seen: string[] = [];
  const off = onApprovalChange((approval) => {
    if (approval.runId === w.runId) seen.push(approval.status);
  });
  try {
    const { id, outcome } = w.pending(30);
    w.ended();
    expect((await outcome).verdict).toBe("deny");
    expect(findApproval(w.k.db, id)?.status).toBe("pending");
    await until(() => findApproval(w.k.db, id)?.status === "expired");
    expect(wakes(w.k.db, w.member.id)).toHaveLength(1);
    expect(wakes(w.k.db, w.member.id)[0]?.detail).toContain('"outcome":"expired"');
    expect(decideApproval(w.k.db, id, "approve", "user:u1")).toBe(false);
    expect(wakes(w.k.db, w.member.id)).toHaveLength(1);
    expect(seen).toEqual(["pending", "expired"]);
  } finally {
    off();
    await stop();
    w.close();
  }
});

test("a decision before expiry announces and wakes once", async () => {
  const w = world();
  const stop = w.k.start();
  const seen: string[] = [];
  const off = onApprovalChange((approval) => {
    if (approval.runId === w.runId) seen.push(approval.status);
  });
  try {
    const { id, outcome } = w.pending(30);
    w.ended();
    await outcome;
    expect(decideApproval(w.k.db, id, "approve", "user:u1")).toBe(true);
    await Bun.sleep(1100);
    expect(findApproval(w.k.db, id)?.status).toBe("approved");
    expect(wakes(w.k.db, w.member.id)).toHaveLength(1);
    expect(seen).toEqual(["pending", "approved"]);
  } finally {
    off();
    await stop();
    w.close();
  }
});

test("startup recovers overdue and future pending approvals without a live waiter", async () => {
  const w = world();
  w.ended();
  for (const [id, expiresAt] of [
    ["overdue", Date.now() - 1],
    ["future", Date.now() + 30],
  ] as const) {
    w.k.db.run(
      "INSERT INTO approvals (id, run_id, action, l1, status, created_at, expires_at) VALUES (?, ?, '{}', '{}', 'pending', 1, ?)",
      [id, w.runId, expiresAt],
    );
  }
  const stop = w.k.start();
  try {
    expect(findApproval(w.k.db, "overdue")?.status).toBe("expired");
    await until(() => findApproval(w.k.db, "future")?.status === "expired");
    expect(wakes(w.k.db, w.member.id)).toHaveLength(2);
    expect(decideApproval(w.k.db, "overdue", "approve", "user:u1")).toBe(false);
    expect(wakes(w.k.db, w.member.id)).toHaveLength(2);
  } finally {
    await stop();
    w.close();
  }
});

test("shutdown clears live approval timers before closing the database", async () => {
  const w = world();
  const stop = w.k.start();
  const { id, outcome } = w.pending(30);
  await stop();
  expect((await outcome).verdict).toBe("deny");
  expect(findApproval(w.k.db, id)?.status).toBe("pending");
  w.close();
  await Bun.sleep(1100);
});

test("a late decision expires a killed run's approval once before the sweep", async () => {
  const w = world();
  const stop = w.k.start();
  const seen: string[] = [];
  const off = onApprovalChange((approval) => {
    if (approval.runId === w.runId) seen.push(approval.status);
  });
  try {
    const { id, outcome } = w.pending(30);
    w.ended();
    await outcome;
    await Bun.sleep(40);
    expect(decideApproval(w.k.db, id, "approve", "user:u1")).toBe(false);
    expect(findApproval(w.k.db, id)?.status).toBe("expired");
    await Bun.sleep(1100);
    expect(wakes(w.k.db, w.member.id)).toHaveLength(1);
    expect(seen).toEqual(["pending", "expired"]);
  } finally {
    off();
    await stop();
    w.close();
  }
});

test("recoverRuns preserves a member's future approval until heartbeat expires and wakes it", async () => {
  const w = world();
  const id = Bun.randomUUIDv7();
  w.k.db.run(
    "INSERT INTO approvals (id, run_id, action, l1, status, created_at, expires_at) VALUES (?, ?, '{}', '{}', 'pending', 1, ?)",
    [id, w.runId, Date.now() + 200],
  );
  recoverRuns(w.k.db);
  expect(findApproval(w.k.db, id)?.status).toBe("pending");
  expect(wakes(w.k.db, w.member.id)).toHaveLength(0);
  const stop = w.k.start();
  try {
    await until(() => findApproval(w.k.db, id)?.status === "expired");
    expect(wakes(w.k.db, w.member.id)).toHaveLength(1);
    expect(wakes(w.k.db, w.member.id)[0]?.detail).toContain('"outcome":"expired"');
    expect(decideApproval(w.k.db, id, "approve", "user:u1")).toBe(false);
    expect(wakes(w.k.db, w.member.id)).toHaveLength(1);
  } finally {
    await stop();
    w.close();
  }
});
