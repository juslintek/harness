import { afterEach, beforeEach, expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createTask, getTask } from "../board/api";
import { ensureProjectChannel, listMessages } from "../chat/api";
import { createPosition, type MemberRow } from "../orgs/api";
import { ensureProfile, submitCard } from "../profiles/api";
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

function team(): ReturnType<typeof world> & { lead: MemberRow; dev: MemberRow; peer: MemberRow } {
  const w = world(db);
  const lead = w.agent(w.a.id, "lead");
  const dev = w.agent(w.a.id, "dev");
  const peer = w.agent(w.a.id, "peer");
  const boss = createPosition(db, {
    orgId: w.a.id,
    title: "Lead",
    memberId: lead.id,
    isManager: true,
  });
  createPosition(db, { orgId: w.a.id, title: "Backend dev", memberId: dev.id, reportsTo: boss.id });
  createPosition(db, { orgId: w.a.id, title: "Designer", memberId: peer.id });
  return { ...w, lead, dev, peer };
}

test("task_delegate to a report creates subtask, assignment, estimate, channel post and parent in_progress", async () => {
  const t = team();
  const parent = createTask(db, {
    projectId: t.project.id,
    title: "Ship it",
    createdBy: t.lead.id,
  });
  const res = await call(server, tokenFor(db, t.lead.id, t.a.id), "task_delegate", {
    task: parent.number,
    to: "dev",
    title: "Write the endpoint",
    description: "POST /x",
    estimateMinutes: 90,
  });
  expect(res.isError).toBe(false);
  const child = db
    .query<{ id: string; number: number }, [string]>(
      "SELECT id, number FROM tasks WHERE parent_id = ?",
    )
    .get(parent.id);
  expect(res.text).toBe(`#${child?.number}`);
  const made = getTask(db, child?.id as string);
  expect(made).toMatchObject({
    assigneeId: t.dev.id,
    title: "Write the endpoint",
    estimateMinutes: 90,
  });
  const kinds = db
    .query<{ kind: string }, [string]>("SELECT kind FROM task_estimates WHERE task_id = ?")
    .all(child?.id as string);
  expect(kinds).toEqual([{ kind: "planner" }]);
  const channel = ensureProjectChannel(db, t.project.id);
  const posted = listMessages(db, channel.id, t.lead.id, {}).map((m) => m.body);
  expect(posted).toContain(`@dev: #${child?.number} Write the endpoint`);
  expect(getTask(db, parent.id)?.status).toBe("in_progress");
});

test("task_delegate leaves no subtask or estimate behind when the parent move fails", async () => {
  const t = team();
  const parent = createTask(db, { projectId: t.project.id, title: "Ship", createdBy: t.lead.id });
  db.run(`CREATE TRIGGER no_parent_move BEFORE UPDATE ON tasks WHEN OLD.id = '${parent.id}'
    BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  const res = await call(server, tokenFor(db, t.lead.id, t.a.id), "task_delegate", {
    task: parent.number,
    to: "dev",
    title: "piece",
    estimateMinutes: 30,
  });
  expect(res.isError).toBe(true);
  const rows = (sql: string): number => db.query<{ n: number }, []>(sql).get()?.n as number;
  expect(rows("SELECT count(*) AS n FROM tasks WHERE parent_id IS NOT NULL")).toBe(0);
  expect(rows("SELECT count(*) AS n FROM task_estimates")).toBe(0);
});

test("a position without the manager flag but with a report can delegate and see a roster", async () => {
  const w = world(db);
  const lead = w.agent(w.a.id, "lead");
  const dev = w.agent(w.a.id, "dev");
  const boss = createPosition(db, { orgId: w.a.id, title: "Lead", memberId: lead.id });
  createPosition(db, { orgId: w.a.id, title: "Dev", memberId: dev.id, reportsTo: boss.id });
  const parent = createTask(db, { projectId: w.project.id, title: "Ship", createdBy: lead.id });
  const token = tokenFor(db, lead.id, w.a.id);
  const res = await call(server, token, "task_delegate", {
    task: parent.number,
    to: "dev",
    title: "piece",
  });
  expect(res.isError).toBe(false);
  const roster = JSON.parse((await call(server, token, "team_roster")).text) as unknown[];
  expect(roster).toHaveLength(1);
});

test("task_delegate to a non-report is refused", async () => {
  const t = team();
  const parent = createTask(db, {
    projectId: t.project.id,
    title: "Ship it",
    createdBy: t.lead.id,
  });
  const res = await call(server, tokenFor(db, t.lead.id, t.a.id), "task_delegate", {
    task: parent.number,
    to: "peer",
    title: "x",
  });
  expect(res).toMatchObject({ isError: true });
  expect(res.text).toContain("not one of your reports");
  const byReport = await call(server, tokenFor(db, t.dev.id, t.a.id), "task_delegate", {
    task: parent.number,
    to: "lead",
    title: "x",
  });
  expect(byReport.isError).toBe(true);
  expect(db.query("SELECT 1 FROM tasks WHERE parent_id = ?").get(parent.id)).toBeNull();
});

test("team_roster lists reports with card summaries", async () => {
  const t = team();
  const profile = ensureProfile(db, t.dev.id);
  submitCard(db, profile.id, {
    summary: "Builds APIs",
    specialties: ["backend"],
    strengths: [],
    limits: ["no UI"],
    preferredTaskTypes: ["feature"],
  });
  createTask(db, {
    projectId: t.project.id,
    title: "open",
    createdBy: t.lead.id,
    assigneeId: t.dev.id,
  });
  const res = await call(server, tokenFor(db, t.lead.id, t.a.id), "team_roster");
  const roster = JSON.parse(res.text) as Record<string, unknown>[];
  expect(roster).toHaveLength(1);
  expect(roster[0]).toMatchObject({
    handle: "dev",
    position: "Backend dev",
    direct: true,
    summary: "Builds APIs",
    specialties: ["backend"],
    openTasks: 1,
    budget: "ok",
  });
});
