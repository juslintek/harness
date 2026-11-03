import { afterAll, expect, test } from "bun:test";
import { budgetGate, startBudgets } from "./features/budgets/api";
import { upsertBudget } from "./features/budgets/repo";
import { wireChat } from "./features/chat/api";
import { addAgentMember, createOrg } from "./features/orgs/api";
import type { RunOutcome } from "./features/runtimes/adapter";
import { startRun, waitForRun, wireRuntimes } from "./features/runtimes/api";
import { cleanup, fakeDeps, fixture } from "./features/runtimes/manager-kit";
import { recordUsage } from "./features/usage/api";

afterAll(cleanup);

test("crossing 100% kills a live run of the member with budget_exhausted and budgetGate is paused", async () => {
  wireRuntimes();
  const x = fixture();
  wireChat(x.db);
  const org = createOrg(x.db, {
    name: "Acme",
    slug: "acme",
    ownerUserId: "u1",
    ownerName: "Owner",
    ownerHandle: "owner",
  });
  const agent = (handle: string) =>
    addAgentMember(x.db, org.id, { agentId: "fake", handle, displayName: handle, specialties: [] });
  const [bob, other] = [agent("bob"), agent("other")] as const;
  const limit = upsertBudget(
    x.db,
    org.id,
    { scopeKind: "member", scopeId: bob.id, monthlyUsd: 1 },
    "owner",
  );
  const stop = startBudgets(x.db);
  let started = false;
  const lane = async (ctx: { signal: AbortSignal }): Promise<RunOutcome> => {
    started = true;
    await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
    return { stopReason: "end_turn", text: "", usage: [], error: null, sessionId: null };
  };
  const runId = await startRun(x.db, fakeDeps(x, [], { lane }), {
    agentId: "fake",
    repo: x.repo,
    prompt: "go",
    member: { memberId: bob.id, orgId: org.id, scopes: ["report"] },
  });
  while (!started) await Bun.sleep(10);
  recordUsage(x.db, { id: runId, agent: "fake" }, [
    {
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      reportedCostUsd: 1.5,
      source: "acp",
    },
  ]);
  const row = await waitForRun(runId);
  stop();
  expect([row.state, row.reason]).toEqual(["killed", "budget_exhausted"]);
  const gate = budgetGate(x.db, bob.id);
  expect(gate.state).toBe("paused");
  expect(gate.budgets[0]).toMatchObject({ id: limit.id, state: "paused" });
  expect(budgetGate(x.db, other.id).state).toBe("ok");
});
