import { afterAll, expect, test } from "bun:test";
import { waitForRun } from "../runtimes/api";
import { linkHandoff, nextAttempt } from "./failover";
import { agents, cleanup, ends, world } from "./failover-kit";

afterAll(cleanup);

test("nextAttempt after rate_limited returns the next engine and the same worktree", async () => {
  const w = world();
  const id = await w.start(ends({ stopReason: "error", error: "rate limit hit" }));
  const done = await waitForRun(id);
  const next = await nextAttempt(w.db, id, agents("claude", "codex"));
  expect(next?.engine).toEqual({ runtime: "codex", model: null });
  expect(next?.reuseWorktreeOf).toBe(id);
  expect(next?.summary).toContain("Fix login");
  const handoff = (): unknown =>
    w.db
      .query("SELECT from_run_id, to_run_id FROM run_handoffs WHERE id = ?")
      .get(next?.handoffId as string);
  expect(handoff()).toEqual({ from_run_id: done.id, to_run_id: null });
  const follow = await w.start(ends({}), { reuseWorktreeOf: id, attempt: 2, batchId: id });
  linkHandoff(w.db, next?.handoffId as string, follow);
  expect(handoff()).toEqual({ from_run_id: done.id, to_run_id: follow });
  await waitForRun(follow);
});

test("nothing fails over after completed, user kill, halt, guard denial, approval timeout or a spent budget", async () => {
  const w = world();
  const stops: Array<[string, string | null]> = [
    ["completed", null],
    ["killed", "killed_by_user"],
    ["killed", "halted"],
    ["blocked", "guard_denied"],
    ["blocked", "approval_timeout"],
    ["failed", "budget_exhausted"],
  ];
  for (const [state, reason] of stops) {
    expect(await nextAttempt(w.db, w.ended(state, reason), agents("claude", "codex"))).toBeNull();
  }
  for (const [state, reason] of [
    ["killed", "quota_exhausted"],
    ["failed", "launch_failed"],
  ] as const) {
    expect(
      await nextAttempt(w.db, w.ended(state, reason), agents("claude", "codex")),
    ).not.toBeNull();
  }
});

test("two nextAttempt calls for the same run produce one handoff", async () => {
  const w = world();
  const id = w.ended("failed", "rate_limited");
  const all = agents("claude", "codex", "agy");
  const got = await Promise.all([nextAttempt(w.db, id, all), nextAttempt(w.db, id, all)]);
  expect(got.filter((r) => r !== null)).toHaveLength(1);
  const count = w.db.query<{ n: number }, []>("SELECT count(*) AS n FROM run_handoffs").get();
  expect(count?.n).toBe(1);
});

test("an attempt never lands on an engine already tried in the batch", async () => {
  const w = world();
  const first = w.ended("failed", "rate_limited");
  const second = w.ended("failed", "rate_limited", {
    agent_id: "codex",
    model: null,
    attempt: 2,
    batch_id: first,
  });
  const next = await nextAttempt(w.db, second, agents("claude", "codex", "agy"));
  expect(next?.engine.runtime).toBe("agy");
  const stuck = w.ended("failed", "rate_limited", { attempt: 2, batch_id: first });
  expect(await nextAttempt(w.db, stuck, agents("claude", "codex"))).toBeNull();
});

test("the third attempt is the last", async () => {
  const w = world();
  const first = w.ended("failed", "rate_limited");
  const third = w.ended("failed", "rate_limited", {
    agent_id: "agy",
    model: null,
    attempt: 3,
    batch_id: first,
  });
  expect(await nextAttempt(w.db, third, agents("claude", "codex", "agy", "gemini"))).toBeNull();
});

test("router.failover off for the member stops the failover", async () => {
  const w = world();
  w.db.run(
    "INSERT INTO policies (id, layer, target_id, key, value, set_by, updated_at) VALUES ('p', 'agent', ?, 'router.failover', 'false', 'x', 1)",
    [w.memberId],
  );
  const id = w.ended("failed", "rate_limited");
  expect(await nextAttempt(w.db, id, agents("claude", "codex"))).toBeNull();
});
