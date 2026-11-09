import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { type ApiKit, bootApi } from "../../test-support/api-kit";

const SECRET = "ORG-A-SECRET-MARKER";

interface Fixture {
  kit: ApiKit;
  ids: Record<string, string>;
  a: Awaited<ReturnType<ApiKit["user"]>>;
  b: Awaited<ReturnType<ApiKit["user"]>>;
}

interface SeedIds {
  orgId: string;
  teamId: string;
  memberId: string;
  channelId: string;
}

// Rows no route creates without a model run or a bridge client, so they go in directly.
function seedRows(db: Database, s: SeedIds): Record<string, string> {
  const hire = Bun.randomUUIDv7();
  db.query(
    `INSERT INTO hire_requests (id, org_id, team_id, requested_by, spec, status, phase_started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'interviewing', 1, 1, 1)`,
  ).run(hire, s.orgId, s.teamId, s.memberId, JSON.stringify({ title: SECRET }));
  const budget = Bun.randomUUIDv7();
  db.query(
    `INSERT INTO budgets (id, org_id, scope_kind, scope_id, monthly_usd, created_by, updated_at)
     VALUES (?, ?, 'org', ?, 10, ?, 1)`,
  ).run(budget, s.orgId, s.orgId, s.memberId);
  const proposal = Bun.randomUUIDv7();
  db.query(
    `INSERT INTO policy_proposals (id, org_id, layer, target_id, key, value, reason, proposed_by, status, created_at)
     VALUES (?, ?, 'agent', ?, 'autonomy', '"full"', ?, ?, 'open', 1)`,
  ).run(proposal, s.orgId, s.memberId, SECRET, s.memberId);
  const bridge = Bun.randomUUIDv7();
  db.query(
    "INSERT INTO bridges (id, org_id, channel_id, kind, external_id, created_at) VALUES (?, ?, ?, 'slack', ?, 1)",
  ).run(bridge, s.orgId, s.channelId, SECRET);
  const target = Bun.randomUUIDv7();
  db.query(
    "INSERT INTO notify_targets (id, member_id, channel, value, created_at) VALUES (?, ?, 'email', ?, 1)",
  ).run(target, s.memberId, `${SECRET}@example.test`);
  return { hire, budget, proposal, bridge, target };
}

async function setup(): Promise<Fixture> {
  const kit = bootApi();
  const { db } = kit;
  // Step-up is on so a 403 can only come from the tenant check, not from a missing step-up.
  const a = await kit.user({ stepUp: true });
  const b = await kit.user({ stepUp: true });
  const orgA = kit.org(a, "alpha");
  kit.org(b, "bravo");
  const post = async (path: string, body: unknown): Promise<{ id: string }> =>
    (await (await kit.call(a, "POST", path, body)).json()) as { id: string };
  const teamRes = await kit.call(a, "POST", "/api/orgs/alpha/teams", { name: "Hiring" });
  const team = (await teamRes.json()) as { id: string };
  const project = await post("/api/orgs/alpha/projects", { key: "AA", name: SECRET });
  const task = await post(`/api/projects/${project.id}/tasks`, { title: SECRET });
  const group = await post("/api/orgs/alpha/groups", { name: SECRET, memberIds: [] });
  const channel = db
    .query<{ id: string }, [string]>("SELECT id FROM channels WHERE org_id = ? AND kind = 'org'")
    .get(orgA.id) as { id: string };
  const member = db
    .query<{ id: string }, [string]>("SELECT id FROM members WHERE org_id = ?")
    .get(orgA.id) as { id: string };
  const rows = seedRows(db, {
    orgId: orgA.id,
    teamId: team.id,
    memberId: member.id,
    channelId: channel.id,
  });
  return {
    kit,
    a,
    b,
    ids: {
      team: team.id,
      project: project.id,
      task: task.id,
      group: group.id,
      channel: channel.id,
      member: member.id,
      ...rows,
      orgA: orgA.id,
    },
  };
}

interface Case {
  name: string;
  method: string;
  path: (ids: Record<string, string>) => string;
  body?: unknown;
}

const note = { scope: "org", rel: "x", body: SECRET };
const cases: Case[] = [
  { name: "board list tasks", method: "GET", path: (i) => `/api/projects/${i.project}/tasks` },
  { name: "board members", method: "GET", path: (i) => `/api/projects/${i.project}/members` },
  { name: "board deps", method: "GET", path: (i) => `/api/projects/${i.project}/deps` },
  {
    name: "board create task",
    method: "POST",
    path: (i) => `/api/projects/${i.project}/tasks`,
    body: { title: "x" },
  },
  { name: "board get task", method: "GET", path: (i) => `/api/tasks/${i.task}` },
  {
    name: "board patch task",
    method: "PATCH",
    path: (i) => `/api/tasks/${i.task}`,
    body: { title: "x" },
  },
  {
    name: "board comment",
    method: "POST",
    path: (i) => `/api/tasks/${i.task}/comments`,
    body: { body: "x" },
  },
  {
    name: "board move",
    method: "POST",
    path: (i) => `/api/tasks/${i.task}/move`,
    body: { to: "todo" },
  },
  { name: "board checkout", method: "POST", path: (i) => `/api/tasks/${i.task}/checkout` },
  { name: "board release", method: "POST", path: (i) => `/api/tasks/${i.task}/release` },
  { name: "chat channels", method: "GET", path: () => "/api/orgs/alpha/channels" },
  {
    name: "chat create group",
    method: "POST",
    path: () => "/api/orgs/alpha/groups",
    body: { name: "x", memberIds: [] },
  },
  {
    name: "chat open dm",
    method: "POST",
    path: () => "/api/orgs/alpha/dms",
    body: { memberId: "m" },
  },
  { name: "chat messages", method: "GET", path: (i) => `/api/channels/${i.channel}/messages` },
  { name: "chat group messages", method: "GET", path: (i) => `/api/channels/${i.group}/messages` },
  {
    name: "chat post",
    method: "POST",
    path: (i) => `/api/channels/${i.channel}/messages`,
    body: { body: "x" },
  },
  { name: "chat members", method: "GET", path: (i) => `/api/channels/${i.channel}/members` },
  { name: "chat read", method: "POST", path: (i) => `/api/channels/${i.channel}/read` },
  { name: "memory notes", method: "GET", path: () => "/api/orgs/alpha/memory/notes" },
  { name: "memory facets", method: "GET", path: () => "/api/orgs/alpha/memory/facets" },
  { name: "memory note", method: "GET", path: () => "/api/orgs/alpha/memory/notes/x" },
  { name: "memory create", method: "POST", path: () => "/api/orgs/alpha/memory/notes", body: note },
  { name: "memory delete", method: "DELETE", path: () => "/api/orgs/alpha/memory/notes/x" },
  { name: "memory writes", method: "GET", path: () => "/api/orgs/alpha/memory/writes" },
  { name: "memory lessons", method: "GET", path: () => "/api/orgs/alpha/memory/lessons" },
  { name: "budgets list", method: "GET", path: () => "/api/orgs/alpha/budgets" },
  {
    name: "budgets put",
    method: "PUT",
    path: () => "/api/orgs/alpha/budgets",
    body: { scopeKind: "org", scopeId: "x", monthlyUsd: 5 },
  },
  { name: "budgets delete", method: "DELETE", path: (i) => `/api/orgs/alpha/budgets/${i.budget}` },
  { name: "policies list", method: "GET", path: () => "/api/orgs/alpha/policies" },
  { name: "policies delete", method: "DELETE", path: () => "/api/orgs/alpha/policies" },
  { name: "policy proposals", method: "GET", path: () => "/api/orgs/alpha/policy-proposals" },
  {
    name: "policy decide",
    method: "POST",
    path: (i) => `/api/orgs/alpha/policy-proposals/${i.proposal}/decide`,
    body: { decision: "approve" },
  },
  { name: "hiring list", method: "GET", path: () => "/api/orgs/alpha/hires" },
  { name: "hiring get", method: "GET", path: (i) => `/api/orgs/alpha/hires/${i.hire}` },
  {
    name: "hiring decide",
    method: "POST",
    path: (i) => `/api/orgs/alpha/hires/${i.hire}/decide`,
    body: { decision: "approve" },
  },
  { name: "bridge links", method: "GET", path: () => "/api/bridge/links?org=alpha" },
  { name: "bridge unlink", method: "DELETE", path: (i) => `/api/bridge/links/${i.bridge}` },
  {
    name: "notify unknown target",
    method: "DELETE",
    path: (i) => `/api/notify/targets/${i.target}`,
  },
  {
    name: "heartbeat wake",
    method: "POST",
    path: (i) => `/api/members/${i.member}/wake`,
    body: {},
  },
  { name: "heartbeat wakeups", method: "GET", path: () => "/api/orgs/alpha/wakeups" },
  { name: "tracking dashboard", method: "GET", path: () => "/api/orgs/alpha/dashboard" },
];

// Cross-id variants: a member of org B names org A's id under org B's own slug.
const crossId: Case[] = [
  { name: "hire id under own slug", method: "GET", path: (i) => `/api/orgs/bravo/hires/${i.hire}` },
  {
    name: "budget id under own slug",
    method: "DELETE",
    path: (i) => `/api/orgs/bravo/budgets/${i.budget}`,
  },
  {
    name: "proposal id under own slug",
    method: "POST",
    path: (i) => `/api/orgs/bravo/policy-proposals/${i.proposal}/decide`,
    body: { decision: "approve" },
  },
];

async function attempt(f: Fixture, c: Case): Promise<void> {
  const res = await f.kit.call(
    f.b,
    c.method,
    c.path(f.ids),
    c.body === undefined ? undefined : c.body,
  );
  const text = await res.text();
  expect([403, 404], `${c.name} -> ${res.status} ${text.slice(0, 120)}`).toContain(res.status);
  expect(text).not.toContain(SECRET);
}

describe("org isolation", () => {
  test("a member of org B is refused org A routes", async () => {
    const f = await setup();
    for (const c of cases) await attempt(f, c);
  });

  test("org A's own admin still reaches the same routes", async () => {
    const f = await setup();
    const res = await f.kit.call(f.a, "GET", `/api/tasks/${f.ids.task}`);
    expect(res.status).toBe(200);
  });

  test("an org A id named under org B's slug is refused", async () => {
    const f = await setup();
    for (const c of crossId) await attempt(f, c);
  });
});
