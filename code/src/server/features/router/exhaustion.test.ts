import { afterAll, expect, test } from "bun:test";
import { getAccount } from "../agents/api";
import { killRun, waitForRun } from "../runtimes/api";
import { recordQuota } from "../usage/api";
import {
  type Adapter,
  cleanup,
  holdUntilKilled,
  outcome,
  type RunOutcome,
  world,
} from "./failover-kit";

afterAll(cleanup);

const MINUTE = 60_000;

function addAccount(db: ReturnType<typeof world>["db"], id: string): void {
  db.run(
    `INSERT INTO agent_accounts (id, runtime, kind, label, home, state, created_at, updated_at)
     VALUES (?, 'claude', 'login', ?, '/h', 'active', 1, 1)`,
    [id, id],
  );
}

// The run is pinned to its account before the lane is allowed to end.
async function endsOn(
  w: ReturnType<typeof world>,
  accountId: string | null,
  end: (ctx: Parameters<Adapter>[0]) => RunOutcome,
): Promise<string> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const id = await w.start(async (ctx) => {
    await gate;
    return end(ctx);
  });
  if (accountId !== null) w.db.run("UPDATE runs SET account_id = ? WHERE id = ?", [accountId, id]);
  release();
  await waitForRun(id);
  return id;
}

const exhaustedUntil = (w: ReturnType<typeof world>, id: string): number | null | undefined =>
  getAccount(w.db, id)?.exhaustedUntil;

test("a rate_limited ending with a quota reason blocks only that account for 15 minutes", async () => {
  const w = world();
  addAccount(w.db, "acct-a");
  addAccount(w.db, "acct-b");
  const before = Date.now();
  const id = await endsOn(w, "acct-a", () =>
    outcome({ stopReason: "error", error: "429 usage limit reached" }),
  );
  expect(exhaustedUntil(w, "acct-a")).toBeGreaterThanOrEqual(before + 15 * MINUTE);
  expect(exhaustedUntil(w, "acct-a")).toBeLessThanOrEqual(Date.now() + 15 * MINUTE);
  expect(exhaustedUntil(w, "acct-b")).toBeNull();
  expect((await waitForRun(id)).reason).toBe("rate_limited");
});

test("a full window reported by a run blocks its account until the reset", async () => {
  const w = world();
  addAccount(w.db, "acct-a");
  const resetsAt = Date.now() + 3 * 60 * MINUTE;
  // The run itself ends cleanly, so only the reading can block the account.
  await endsOn(w, "acct-a", (ctx) => {
    ctx.onQuota({ provider: "claude", window: "five_hour", usedPercent: 100, resetsAt });
    return outcome({ stopReason: "end_turn" });
  });
  expect(exhaustedUntil(w, "acct-a")).toBe(resetsAt);
});

test("a quota ending blocks until the reset of the account's full window", async () => {
  const w = world();
  addAccount(w.db, "acct-a");
  const resetsAt = Date.now() + 3 * 60 * MINUTE;
  // Recorded outside the run, so the run's own quota handling never sees it.
  recordQuota(w.db, {
    provider: "claude",
    accountId: "acct-a",
    window: "five_hour",
    usedPercent: 100,
    resetsAt,
    source: "acp",
  });
  await endsOn(w, "acct-a", () => outcome({ stopReason: "error", error: "usage limit" }));
  expect(exhaustedUntil(w, "acct-a")).toBe(resetsAt);
});

test("an overloaded ending skips the account for 2 minutes only", async () => {
  const w = world();
  addAccount(w.db, "acct-a");
  const before = Date.now();
  const id = await endsOn(w, "acct-a", () =>
    outcome({ stopReason: "error", error: "API overloaded, try again" }),
  );
  expect(exhaustedUntil(w, "acct-a")).toBeGreaterThanOrEqual(before + 2 * MINUTE);
  expect(exhaustedUntil(w, "acct-a")).toBeLessThanOrEqual(Date.now() + 2 * MINUTE);
  expect((await waitForRun(id)).reason).toBe("rate_limited");
});

test("a short overloaded skip never shortens a longer quota block", async () => {
  const w = world();
  addAccount(w.db, "acct-a");
  await endsOn(w, "acct-a", () => outcome({ stopReason: "error", error: "usage limit" }));
  const blocked = exhaustedUntil(w, "acct-a");
  await endsOn(w, "acct-a", () => outcome({ stopReason: "error", error: "overloaded" }));
  expect(exhaustedUntil(w, "acct-a")).toBe(blocked);
});

test("a run without an account marks the default account of its runtime", async () => {
  const w = world();
  await endsOn(w, null, () => outcome({ stopReason: "error", error: "rate limit" }));
  expect(exhaustedUntil(w, "default:claude")).toBeGreaterThan(Date.now());
});

test("a run killed with quota_exhausted marks its account", async () => {
  const w = world();
  addAccount(w.db, "acct-a");
  const id = await w.start(holdUntilKilled());
  w.db.run("UPDATE runs SET account_id = 'acct-a' WHERE id = ?", [id]);
  killRun(w.db, id, "quota_exhausted");
  await waitForRun(id);
  expect(exhaustedUntil(w, "acct-a")).toBeGreaterThan(Date.now());
});

test("an ordinary failure does not block the account", async () => {
  const w = world();
  addAccount(w.db, "acct-a");
  await endsOn(w, "acct-a", () => outcome({ stopReason: "error", error: "segfault" }));
  expect(exhaustedUntil(w, "acct-a")).toBeNull();
});
