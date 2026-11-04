import { expect, test } from "bun:test";
import { type ApiKit, bootApi } from "../../test-support/api-kit";
import { createTask } from "../board/api";
import { upsertBudget } from "../budgets/api";
import { addAgentMember, createProject } from "../orgs/api";
import { addEstimate } from "./api";

const NOW = Date.now();

function seedRun(k: ApiKit, org: { id: string; owner: { id: string } }): { number: number } {
  const bot = addAgentMember(k.db, org.id, {
    agentId: "claude",
    handle: "bot",
    displayName: "bot",
    specialties: [],
  });
  const project = createProject(k.db, { orgId: org.id, key: "P", name: "P" });
  const task = createTask(k.db, {
    projectId: project.id,
    title: "ship it",
    createdBy: org.owner.id,
  });
  k.db.query("UPDATE tasks SET assignee_id = ? WHERE id = ?").run(bot.id, task.id);
  addEstimate(k.db, { taskId: task.id, kind: "planner", minutes: 120, source: "human" });
  k.db
    .query(
      `INSERT INTO runs (id, agent_id, repo, prompt, state, created_at, started_at, ended_at, member_id, task_id)
       VALUES ('r1', 'claude', '/r', 'p', 'completed', ?1, ?1, ?2, ?3, ?4)`,
    )
    .run(NOW - 120_000, NOW - 60_000, bot.id, task.id);
  k.db
    .query(
      `INSERT INTO events (id, ts, run_id, agent, kind, gen_ai_usage_input_tokens, gen_ai_usage_output_tokens,
         reported_cost_usd) VALUES ('e1', ?, 'r1', 'claude', 'usage', 300, 30, 0.75)`,
    )
    .run(NOW - 90_000);
  upsertBudget(k.db, org.id, { scopeKind: "member", scopeId: bot.id, monthlyUsd: 1 }, org.owner.id);
  return task;
}

test("dashboard returns per-member tokens, time and estimates for a seeded run", async () => {
  const k = bootApi();
  const owner = await k.user();
  const task = seedRun(k, k.org(owner, "acme"));

  const res = await k.call(owner, "GET", `/api/orgs/acme/dashboard?since=${NOW - 3_600_000}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    members: {
      handle: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      wallMs: number;
      activeMs: number;
      plannerMinutes: number;
    }[];
    budgets: { state: string; spentUsd: number }[];
    quota: { provider: string }[];
    tasks: {
      number: number;
      assignee: string;
      plannerMinutes: number;
      agentActiveMinutes: number;
    }[];
  };
  expect(body.members.find((m) => m.handle === "bot")).toMatchObject({
    inputTokens: 300,
    outputTokens: 30,
    costUsd: 0.75,
    wallMs: 60_000,
    activeMs: 60_000,
  });
  expect(body.budgets).toMatchObject([{ state: "ok", spentUsd: 0.75 }]);
  expect(body.quota.map((q) => q.provider)).toEqual(["claude", "codex", "agy"]);
  expect(body.tasks).toMatchObject([
    { number: task.number, assignee: "bot", plannerMinutes: 120, agentActiveMinutes: 1 },
  ]);
});

test("viewer of another org gets 403, a bad since gets 400, a plain viewer may read", async () => {
  const k = bootApi();
  const owner = await k.user();
  const org = k.org(owner, "acme");
  const stranger = await k.user();
  k.org(stranger, "other");
  expect((await k.call(stranger, "GET", "/api/orgs/acme/dashboard")).status).toBe(403);
  expect((await k.call(stranger, "GET", "/api/orgs/nope/dashboard")).status).toBe(403);

  const viewer = await k.user();
  k.join(org.id, viewer, "viewer", "vee");
  expect((await k.call(viewer, "GET", "/api/orgs/acme/dashboard")).status).toBe(200);
  expect((await k.call(viewer, "GET", "/api/orgs/acme/dashboard?since=abc")).status).toBe(400);
});
