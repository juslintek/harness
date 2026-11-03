import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createTask } from "../board/api";
import { addAgentMember, createOrg, createProject } from "../orgs/api";
import { addEstimate, estimatesOf, memberReport, priorFor } from "./api";
import { seedPrior } from "./estimates";

function setup() {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const org = createOrg(db, {
    name: "Acme",
    slug: "acme",
    ownerUserId: "u1",
    ownerName: "Owner",
    ownerHandle: "owner",
  });
  const project = createProject(db, { orgId: org.id, key: "pr", name: "p" });
  const bot = addAgentMember(db, org.id, {
    agentId: "claude",
    handle: "bot",
    displayName: "bot",
    specialties: [],
  });
  const task = createTask(db, { projectId: project.id, title: "t", createdBy: "x" });
  return { db, org, bot, task };
}

function triage(db: ReturnType<typeof setup>["db"], taskId: string, size: string): void {
  db.query(
    `INSERT INTO task_triage (task_id, difficulty, task_type, specialty, size, source, detail, created_at)
     VALUES (?, 'easy', 'feature', NULL, ?, 'laya', '{}', 1)`,
  ).run(taskId, size);
}

test("triage size m gives a laya_prior planner estimate of 240 when none exists", () => {
  const { db, task } = setup();
  triage(db, task.id, "m");
  seedPrior(db, task.id);
  expect(priorFor(db, task.id)).toBe(240);
  expect(estimatesOf(db, task.id).map((e) => [e.source, e.minutes])).toEqual([["laya_prior", 240]]);
  seedPrior(db, task.id);
  expect(estimatesOf(db, task.id)).toHaveLength(1);
});

test("an agent estimate blocks the prior, and a planner estimate sets the task estimate", () => {
  const { db, task, bot } = setup();
  triage(db, task.id, "m");
  addEstimate(db, {
    taskId: task.id,
    kind: "planner",
    minutes: 90,
    source: "agent",
    byMember: bot.id,
  });
  seedPrior(db, task.id);
  expect(estimatesOf(db, task.id).map((e) => [e.source, e.minutes])).toEqual([["agent", 90]]);
  expect(db.query("SELECT estimate_minutes AS m FROM tasks WHERE id = ?").get(task.id)).toEqual({
    m: 90,
  });
});

test("memberReport sums tokens and cost per member and the estimates of done tasks", () => {
  const { db, org, bot, task } = setup();
  addEstimate(db, { taskId: task.id, kind: "planner", minutes: 60, source: "human" });
  addEstimate(db, { taskId: task.id, kind: "planner", minutes: 120, source: "agent" });
  addEstimate(db, { taskId: task.id, kind: "reviewer", minutes: 30, source: "agent" });
  db.query("UPDATE tasks SET status = 'done', updated_at = 5000, assignee_id = ? WHERE id = ?").run(
    bot.id,
    task.id,
  );
  db.query(
    `INSERT INTO runs (id, agent_id, repo, prompt, state, created_at, started_at, ended_at, member_id)
     VALUES ('r1', 'claude', '/r', 'p', 'completed', 1000, 1000, 61000, ?)`,
  ).run(bot.id);
  db.query("INSERT INTO run_stack (run_id, item) VALUES ('r1', 'node')").run();
  const usage = db.query(
    `INSERT INTO events (id, ts, run_id, agent, kind, gen_ai_usage_input_tokens, gen_ai_usage_output_tokens,
       cache_read_tokens, reported_cost_usd) VALUES (?, 2000, 'r1', 'claude', ?, ?, ?, ?, ?)`,
  );
  usage.run("e1", "usage", 100, 10, 5, 0.5);
  usage.run("e2", "usage", 200, 20, 0, 0.25);
  db.query(
    "INSERT INTO events (id, ts, run_id, agent, kind, gen_ai_tool_name) VALUES ('e3', 2000, 'r1', 'claude', 'tool_call', 'Bash')",
  ).run();
  const report = memberReport(db, org.id, 0).find((r) => r.memberId === bot.id);
  expect(report).toMatchObject({
    runs: 1,
    completed: 1,
    inputTokens: 300,
    outputTokens: 30,
    cacheReadTokens: 5,
    costUsd: 0.75,
    unpricedEvents: 0,
    wallMs: 60_000,
    plannerMinutes: 120,
    reviewerMinutes: 30,
    tasksDone: 1,
    tools: [{ name: "Bash", count: 1 }],
    stack: ["node"],
  });
});
