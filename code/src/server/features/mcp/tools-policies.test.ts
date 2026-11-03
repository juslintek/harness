import { afterEach, beforeEach, expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createTask } from "../board/api";
import { createPosition } from "../orgs/api";
import { listProposals, setPolicy } from "../policies/api";
import { estimatesOf } from "../tracking/api";
import { call, type Db, listen, tokenFor, world } from "./test-kit";

let db: Db;
let server: ReturnType<typeof Bun.serve>;

beforeEach(async () => {
  db = openDb(":memory:");
  migrate(db, migrations);
  server = await listen(db);
});
afterEach(() => {
  server.stop(true);
});

const POLICY = ["report", "guard_hook", "board", "policy"] as const;

function team() {
  const w = world(db);
  const boss = w.agent(w.a.id, "boss");
  const dev = w.agent(w.a.id, "dev");
  const lead = createPosition(db, {
    orgId: w.a.id,
    title: "lead",
    memberId: boss.id,
    isManager: true,
  });
  createPosition(db, { orgId: w.a.id, title: "dev", memberId: dev.id, reportsTo: lead.id });
  const as = (member: { id: string }, orgId = w.a.id) =>
    tokenFor(db, member.id, orgId, [...POLICY]);
  return { w, boss, dev, as };
}

test("policy_get lists the effective values with the layer that decides them", async () => {
  const { w, dev, as } = team();
  setPolicy(db, {
    layer: "org",
    targetId: w.a.id,
    key: "autonomy",
    value: "supervised",
    setBy: "t",
  });
  const out = await call(server, as(dev), "policy_get", { key: "autonomy" });
  expect(JSON.parse(out.text)).toEqual([
    {
      key: "autonomy",
      value: "supervised",
      layer: "org",
      chain: [{ layer: "org", targetId: w.a.id, value: "supervised" }],
    },
  ]);
  expect(JSON.parse((await call(server, as(dev), "policy_get")).text).length).toBeGreaterThan(1);
});

test("an agent proposes autonomy full under a strict org and its manager cannot approve it", async () => {
  const { w, boss, dev, as } = team();
  setPolicy(db, { layer: "org", targetId: w.a.id, key: "autonomy", value: "strict", setBy: "t" });
  const made = await call(server, as(dev), "policy_propose", {
    key: "autonomy",
    value: "full",
    reason: "I need to move faster",
    reviewers: ["@boss"],
  });
  expect(made.isError).toBe(false);
  const { proposal } = JSON.parse(made.text) as { proposal: string };
  expect(listProposals(db, w.a.id, "open")).toMatchObject([
    { id: proposal, targetId: dev.id, key: "autonomy", value: "full", reviewers: [boss.id] },
  ]);
  const decided = await call(server, as(boss), "policy_decide", {
    proposal,
    decision: "approve",
    reason: "ok",
  });
  expect(decided).toEqual({ isError: true, text: "an agent cannot approve loosening this key" });
  expect(listProposals(db, w.a.id, "open")).toHaveLength(1);
  const rejected = await call(server, as(boss), "policy_decide", {
    proposal,
    decision: "reject",
    reason: "no",
  });
  expect(rejected.isError).toBe(false);
});

test("a proposal always targets the proposer, whatever else the call names", async () => {
  const { w, boss, dev, as } = team();
  await call(server, as(dev), "policy_propose", {
    key: "autonomy",
    value: "strict",
    reason: "careful",
    layer: "org",
    target: boss.id,
    member: boss.id,
  });
  expect(listProposals(db, w.a.id)).toMatchObject([{ layer: "agent", targetId: dev.id }]);
});

test("the policy tools refuse a bad value, a self review, a peer decider and another org", async () => {
  const { w, boss, dev, as } = team();
  const bad = await call(server, as(dev), "policy_propose", {
    key: "autonomy",
    value: "wild",
    reason: "x",
  });
  expect(bad).toEqual({ isError: true, text: "invalid value" });
  const { proposal } = JSON.parse(
    (
      await call(server, as(dev), "policy_propose", {
        key: "autonomy",
        value: "strict",
        reason: "x",
      })
    ).text,
  ) as { proposal: string };
  const self = await call(server, as(dev), "policy_review", {
    proposal,
    verdict: "approve",
    comment: "",
  });
  expect(self).toEqual({ isError: true, text: "a proposer cannot review their own proposal" });
  const peer = w.agent(w.a.id, "peer");
  const notManager = await call(server, as(peer), "policy_decide", {
    proposal,
    decision: "approve",
  });
  expect(notManager).toEqual({ isError: true, text: "decider is not a manager of the proposer" });
  const outsider = w.agent(w.b.id, "outsider");
  const other = as(outsider, w.b.id);
  expect(await call(server, other, "policy_review", { proposal, verdict: "approve" })).toEqual({
    isError: true,
    text: "unknown proposal",
  });
  expect(await call(server, other, "policy_decide", { proposal, decision: "approve" })).toEqual({
    isError: true,
    text: "unknown proposal",
  });
  expect(
    (await call(server, as(boss), "policy_review", { proposal, verdict: "approve" })).isError,
  ).toBe(false);
});

test("task_estimate stores a reviewer estimate and task_create stores the planner one as the agent's", async () => {
  const { w, dev, as } = team();
  const task = createTask(db, { projectId: w.project.id, title: "t", createdBy: dev.id });
  const token = as(dev);
  const reviewed = await call(server, token, "task_estimate", {
    task: task.number,
    minutes: 90,
    kind: "reviewer",
    rationale: "touches billing",
  });
  expect(reviewed.isError).toBe(false);
  const created = await call(server, token, "task_create", {
    project: "web",
    title: "n",
    estimateMinutes: 45,
  });
  const { id } = JSON.parse(created.text) as { id: string };
  expect(estimatesOf(db, task.id)).toMatchObject([
    {
      kind: "reviewer",
      minutes: 90,
      source: "agent",
      byMember: dev.id,
      rationale: "touches billing",
    },
  ]);
  expect(estimatesOf(db, id)).toMatchObject([{ kind: "planner", minutes: 45, source: "agent" }]);
});

test("task_get shows the triage and the size prior in minutes", async () => {
  const { w, dev, as } = team();
  const task = createTask(db, { projectId: w.project.id, title: "t", createdBy: dev.id });
  db.run(
    "INSERT INTO task_triage (task_id, difficulty, task_type, specialty, size, source, detail, created_at) VALUES (?, 'hard', 'bugfix', 'backend', 'm', 'laya', '{}', 1)",
    [task.id],
  );
  const got = JSON.parse((await call(server, as(dev), "task_get", { task: task.number })).text);
  expect(got).toMatchObject({
    triage: { difficulty: "hard", type: "bugfix", specialty: "backend", size: "m" },
    prior: "240 min",
  });
});
