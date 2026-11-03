import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HiringWorld, hiringWorld } from "../../test-support/hiring-kit";
import { budgetGate, startBudgets, upsertBudget } from "../budgets/api";
import { wireChat } from "../chat/api";
import { verifyRunToken } from "../mcp/api";
import { getRun, type RunDeps } from "../runtimes/api";
import { recordUsage } from "../usage/api";
import { getHire, recordAnswer } from "./api";
import { runInterview } from "./interview";

const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

type Lane = NonNullable<RunDeps["lane"]>;
type Outcome = Awaited<ReturnType<Lane>>;
const finished: Outcome = {
  stopReason: "end_turn",
  text: "",
  usage: [],
  error: null,
  sessionId: null,
};

type RunIdentity = NonNullable<ReturnType<typeof verifyRunToken>>;

interface Seen {
  identity: RunIdentity | null;
  prompt: string;
  runId: string;
}

// The lane stands in for the agent: `behave` gets the identity its token resolves to and may call the same code the MCP tools call.
function interviewEnv(
  w: HiringWorld,
  behave: (id: RunIdentity) => void,
): { env: Parameters<typeof runInterview>[1]; seen: Seen[] } {
  const home = mkdtempSync(join(tmpdir(), "interview-"));
  homes.push(home);
  const seen: Seen[] = [];
  const lane: Lane = async (ctx) => {
    const identity = ctx.mcp ? verifyRunToken(w.db, ctx.mcp.token) : null;
    seen.push({ identity, prompt: ctx.prompt, runId: ctx.runId });
    if (identity) behave(identity);
    return finished;
  };
  return { env: { home, runDeps: { home, port: 1, lane } }, seen };
}

test("interview run gets a candidate token with interview scope only", async () => {
  const w = hiringWorld();
  const hire = await w.file();
  const cand = hire.candidates[0];
  const { env, seen } = interviewEnv(w, () => {});
  await runInterview(
    w.db,
    env,
    w.deps,
    cand?.id as string,
    hire.questions.map((q) => q.id),
  );
  expect(seen).toHaveLength(1);
  expect(seen[0]?.identity).toEqual({
    runId: seen[0]?.runId as string,
    scopes: ["report", "guard_hook", "interview"],
    memberId: null,
    orgId: w.orgId,
    candidateId: cand?.id as string,
  });
  const run = getRun(w.db, seen[0]?.runId as string);
  expect(run).toMatchObject({ memberId: null, agentId: "claude", state: "completed" });
  expect(run?.repo).toContain(join("scratch", w.orgId));
});

test("the prompt carries persona, role, org, questions with ids and the card fields", async () => {
  const w = hiringWorld();
  const hire = await w.file();
  const { env, seen } = interviewEnv(w, () => {});
  await runInterview(
    w.db,
    env,
    w.deps,
    hire.candidates[0]?.id as string,
    hire.questions.map((q) => q.id),
  );
  const prompt = seen[0]?.prompt ?? "";
  expect(prompt.startsWith("You are a Backend Engineer.")).toBe(true);
  expect(prompt).toContain("You are interviewing for Backend Engineer at A.");
  expect(prompt).toContain("`interview_answer`");
  expect(prompt).toContain("`profile_card_submit`");
  for (const q of hire.questions) expect(prompt).toContain(`${q.id}: ${q.body}`);
  for (const field of ["summary", "specialties", "strengths", "limits", "preferredTaskTypes"]) {
    expect(prompt).toContain(field);
  }
});

test("when both interview runs end with every answer in, the request moves to follow-ups", async () => {
  const w = hiringWorld();
  const hire = await w.file();
  const ids = hire.questions.map((q) => q.id);
  const { env } = interviewEnv(w, (id) => {
    for (const q of ids) recordAnswer(w.db, id.candidateId as string, q, "answer", id.runId);
  });
  await Promise.all(hire.candidates.map((c) => runInterview(w.db, env, w.deps, c.id, ids)));
  const now = getHire(w.db, hire.id);
  expect(now?.status).toBe("followups");
  expect(now?.candidates.map((c) => c.status)).toEqual(["answered", "answered"]);
  expect(now?.candidates[0]?.answers[0]?.runId).not.toBeNull();
  expect(w.wakes.some((x) => x.reason === "hire_review")).toBe(true);
});

test("a run that ends without answering fails its candidate and a launch failure does too", async () => {
  const w = hiringWorld();
  const hire = await w.file();
  const ids = hire.questions.map((q) => q.id);
  const { env } = interviewEnv(w, () => {});
  await runInterview(w.db, env, w.deps, hire.candidates[0]?.id as string, ids);
  const broken = { ...env, runDeps: { ...env.runDeps, resolveSpec: () => null } };
  await runInterview(w.db, broken, w.deps, hire.candidates[1]?.id as string, ids);
  const now = getHire(w.db, hire.id);
  expect(now?.candidates.map((c) => c.status)).toEqual(["failed", "failed"]);
  expect(now?.status).toBe("rejected");
  expect(now?.decisionReason).toBe("no candidate answered");
});

function usage(db: HiringWorld["db"], runId: string, usd: number): void {
  recordUsage(db, { id: runId, agent: "claude" }, [
    {
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      reportedCostUsd: usd,
      source: "acp",
    },
  ]);
}

test("an interview run counts against the requester's budget and is killed when it runs out", async () => {
  const w = hiringWorld();
  wireChat(w.db);
  const hire = await w.file();
  upsertBudget(w.db, w.orgId, { scopeKind: "member", scopeId: w.boss.id, monthlyUsd: 1 }, "owner");
  const stop = startBudgets(w.db);
  const home = mkdtempSync(join(tmpdir(), "interview-"));
  homes.push(home);
  const lane: Lane = async (ctx) => {
    usage(w.db, ctx.runId, 1.5);
    // The usage above already tripped the kill, so the signal may have fired before this line.
    if (!ctx.signal.aborted) {
      await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
    }
    return finished;
  };
  const env = { home, runDeps: { home, port: 1, lane } };
  await runInterview(
    w.db,
    env,
    w.deps,
    hire.candidates[0]?.id as string,
    hire.questions.map((q) => q.id),
  );
  stop();
  const run = w.db
    .query<
      { member_id: string | null; charged_to: string | null; state: string; reason: string },
      []
    >("SELECT member_id, charged_to, state, reason FROM runs")
    .get();
  expect(run).toEqual({
    member_id: null,
    charged_to: w.boss.id,
    state: "killed",
    reason: "budget_exhausted",
  });
  expect(budgetGate(w.db, w.boss.id).state).toBe("paused");
});

test("no interview run starts while the requester's budget is exhausted", async () => {
  const w = hiringWorld();
  const hire = await w.file();
  const { env, seen } = interviewEnv(w, () => {});
  const paused = { ...w.deps, budgetPaused: () => true };
  await runInterview(
    w.db,
    env,
    paused,
    hire.candidates[0]?.id as string,
    hire.questions.map((q) => q.id),
  );
  expect(seen).toHaveLength(0);
  expect(getHire(w.db, hire.id)?.candidates[0]?.status).toBe("failed");
});
