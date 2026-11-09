import { type Case, defineCases, type Fixture, type Ids } from "./isolation-kit";

const rand = (): string => Bun.randomUUIDv7().slice(-8);

// A member the request may delete, made fresh because the control consumes it.
async function victim(f: Fixture): Promise<Ids> {
  const user = await f.kit.user();
  return { victim: f.kit.join(f.scope.orgId, user, "member", `v${rand()}`).id };
}

const cases: Case[] = [
  { name: "org view", method: "GET", path: () => "/api/orgs/alpha" },
  {
    name: "create team",
    method: "POST",
    path: () => "/api/orgs/alpha/teams",
    body: () => ({ name: "Platform" }),
  },
  {
    name: "add team member",
    method: "POST",
    path: (i) => `/api/orgs/alpha/teams/${i.team}/members`,
    body: (i) => ({ memberId: i.peer }),
  },
  {
    name: "create project",
    method: "POST",
    path: () => "/api/orgs/alpha/projects",
    body: () => ({ key: "ZZ", name: "Second" }),
  },
  {
    name: "project grant",
    method: "POST",
    path: (i) => `/api/projects/${i.project}/grants`,
    body: (i) => ({ orgId: i.orgB, permission: "read" }),
  },
  {
    name: "project grant revoke",
    method: "DELETE",
    path: (i) => `/api/projects/${i.project}/grants`,
    body: (i) => ({ orgId: i.orgB }),
  },
  {
    name: "invite human",
    method: "POST",
    path: () => "/api/orgs/alpha/members/humans",
    body: () => ({ email: `${rand()}@example.test`, role: "member" }),
  },
  {
    name: "add agent member",
    method: "POST",
    path: () => "/api/orgs/alpha/members/agents",
    body: () => ({ agentId: "claude", handle: `bot-${rand()}`, displayName: "Bot" }),
  },
  {
    name: "patch member",
    method: "PATCH",
    path: (i) => `/api/orgs/alpha/members/${i.peer}`,
    body: () => ({ displayName: "Carol" }),
  },
  {
    name: "remove member",
    method: "DELETE",
    path: (i) => `/api/orgs/alpha/members/${i.victim}`,
    fresh: victim,
  },
  {
    name: "create position",
    method: "POST",
    path: () => "/api/orgs/alpha/positions",
    body: () => ({ title: "Lead" }),
  },
  {
    name: "patch position",
    method: "PATCH",
    path: (i) => `/api/orgs/alpha/positions/${i.position}`,
    body: () => ({ title: "Principal" }),
  },
  {
    name: "member id under own slug",
    method: "PATCH",
    path: (i) => `/api/orgs/alpha/members/${i.peer}`,
    attackPath: (i) => `/api/orgs/bravo/members/${i.peer}`,
    body: () => ({ displayName: "Carol" }),
  },
  {
    name: "position id under own slug",
    method: "PATCH",
    path: (i) => `/api/orgs/alpha/positions/${i.position}`,
    attackPath: (i) => `/api/orgs/bravo/positions/${i.position}`,
    body: () => ({ title: "Principal" }),
  },
  {
    name: "team id under own slug",
    method: "POST",
    path: (i) => `/api/orgs/alpha/teams/${i.team}/members`,
    attackPath: (i) => `/api/orgs/bravo/teams/${i.team}/members`,
    body: (i) => ({ memberId: i.peer }),
  },
];

defineCases("org isolation: orgs, teams, projects, members, positions", cases);
