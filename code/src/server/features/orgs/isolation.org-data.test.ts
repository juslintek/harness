import { type Case, defineCases, type Fixture, type Ids } from "./isolation-kit";
import { seedBridge, seedBudget, seedHire, seedProposal, seedTarget } from "./isolation-seed";

const rand = (): string => Bun.randomUUIDv7().slice(-8);

const budget = (f: Fixture): Ids => ({ budget: seedBudget(f.kit.db, f.scope) });
const proposal = (f: Fixture): Ids => ({ proposal: seedProposal(f.kit.db, f.scope) });
const bridge = (f: Fixture): Ids => ({ bridge: seedBridge(f.kit.db, f.scope) });
const target = (f: Fixture): Ids => ({ target: seedTarget(f.kit.db, f.scope) });
const hire = (f: Fixture): Ids => seedHire(f.kit.db, f.scope);

// The test app has no model runtime, so a hiring write that passes the tenant check answers 503.
const NO_RUNTIME = [200, 201, 503] as const;
const spec = {
  title: "Backend dev",
  specialty: "backend",
  summary: "Owns the API",
  mustHave: [],
  taskTypes: ["feature"],
};
const policy = { layer: "org", key: "heartbeat.maxRunsPerHour" };

const cases: Case[] = [
  { name: "budgets list", method: "GET", path: () => "/api/orgs/alpha/budgets" },
  {
    name: "budgets put",
    method: "PUT",
    path: () => "/api/orgs/alpha/budgets",
    body: (i) => ({ scopeKind: "org", scopeId: i.orgA, monthlyUsd: 5 }),
  },
  {
    name: "budgets delete",
    method: "DELETE",
    path: (i) => `/api/orgs/alpha/budgets/${i.budget}`,
    fresh: budget,
  },
  {
    name: "budget id under own slug",
    method: "DELETE",
    path: (i) => `/api/orgs/alpha/budgets/${i.budget}`,
    attackPath: (i) => `/api/orgs/bravo/budgets/${i.budget}`,
    fresh: budget,
  },
  { name: "policies list", method: "GET", path: () => "/api/orgs/alpha/policies" },
  {
    name: "policies explain scoped",
    method: "GET",
    path: (i) => `/api/orgs/alpha/policies?team=${i.team}&member=${i.agent}&task=${i.task}`,
  },
  {
    name: "policies put",
    method: "PUT",
    path: () => "/api/orgs/alpha/policies",
    body: (i) => ({ ...policy, targetId: i.orgA, value: 7 }),
  },
  {
    name: "policies delete",
    method: "DELETE",
    path: (i) => `/api/orgs/alpha/policies?layer=org&targetId=${i.orgA}&key=${policy.key}`,
  },
  { name: "policy proposals", method: "GET", path: () => "/api/orgs/alpha/policy-proposals" },
  {
    name: "policy decide",
    method: "POST",
    path: (i) => `/api/orgs/alpha/policy-proposals/${i.proposal}/decide`,
    body: () => ({ decision: "reject", reason: "no" }),
    fresh: proposal,
  },
  {
    name: "proposal id under own slug",
    method: "POST",
    path: (i) => `/api/orgs/alpha/policy-proposals/${i.proposal}/decide`,
    attackPath: (i) => `/api/orgs/bravo/policy-proposals/${i.proposal}/decide`,
    body: () => ({ decision: "reject", reason: "no" }),
    fresh: proposal,
  },
  { name: "hiring list", method: "GET", path: () => "/api/orgs/alpha/hires" },
  { name: "hiring get", method: "GET", path: (i) => `/api/orgs/alpha/hires/${i.hire}` },
  {
    name: "hire id under own slug",
    method: "GET",
    path: (i) => `/api/orgs/alpha/hires/${i.hire}`,
    attackPath: (i) => `/api/orgs/bravo/hires/${i.hire}`,
  },
  {
    name: "hiring create",
    method: "POST",
    path: () => "/api/orgs/alpha/hires",
    body: (i) => ({ teamId: i.team, spec }),
    accepts: NO_RUNTIME,
  },
  {
    name: "hiring score",
    method: "POST",
    path: (i) => `/api/orgs/alpha/hires/${i.hire}/score/${i.candidate}`,
    body: () => ({ fit: 3, depth: 3, honesty: 3 }),
    fresh: hire,
    accepts: NO_RUNTIME,
  },
  {
    name: "hire id under own slug for score",
    method: "POST",
    path: (i) => `/api/orgs/alpha/hires/${i.hire}/score/${i.candidate}`,
    attackPath: (i) => `/api/orgs/bravo/hires/${i.hire}/score/${i.candidate}`,
    body: () => ({ fit: 3, depth: 3, honesty: 3 }),
    fresh: hire,
    accepts: NO_RUNTIME,
  },
  {
    name: "hire id under own slug for decide",
    method: "POST",
    path: (i) => `/api/orgs/alpha/hires/${i.hire}/decide`,
    attackPath: (i) => `/api/orgs/bravo/hires/${i.hire}/decide`,
    body: () => ({ candidateId: null, reason: "no fit" }),
    fresh: hire,
    accepts: [200, 409, 503],
  },
  {
    name: "hiring decide",
    method: "POST",
    path: (i) => `/api/orgs/alpha/hires/${i.hire}/decide`,
    body: () => ({ candidateId: null, reason: "no fit" }),
    fresh: hire,
    accepts: [200, 409, 503],
  },
  { name: "bridge links", method: "GET", path: () => "/api/bridge/links?org=alpha" },
  {
    name: "bridge link channel",
    method: "POST",
    path: () => "/api/bridge/links",
    body: (i) => ({ channelId: i.projectChannel, kind: "slack", externalId: `C${rand()}` }),
  },
  {
    name: "bridge unlink",
    method: "DELETE",
    path: (i) => `/api/bridge/links/${i.bridge}`,
    fresh: bridge,
  },
  {
    name: "notify list targets under org A slug",
    method: "GET",
    path: () => "/api/notify/targets?org=alpha",
  },
  {
    name: "notify delete target",
    method: "DELETE",
    path: (i) => `/api/notify/targets/${i.target}`,
    fresh: target,
  },
  {
    name: "notify delete target under org A slug",
    method: "DELETE",
    path: (i) => `/api/notify/targets/${i.target}?org=alpha`,
    fresh: target,
  },
  {
    name: "heartbeat wake",
    method: "POST",
    path: (i) => `/api/members/${i.agent}/wake`,
    body: () => ({}),
    accepts: [202],
  },
  {
    name: "heartbeat wake for task",
    method: "POST",
    path: (i) => `/api/members/${i.agent}/wake`,
    body: (i) => ({ taskId: i.task }),
    accepts: [202],
  },
  { name: "heartbeat wakeups", method: "GET", path: () => "/api/orgs/alpha/wakeups" },
  { name: "tracking dashboard", method: "GET", path: () => "/api/orgs/alpha/dashboard" },
  { name: "logs search", method: "GET", path: () => "/api/orgs/alpha/logs/search?q=build" },
];

defineCases(
  "org isolation: budgets, policies, hiring, bridge, notify, wakes, tracking, logs",
  cases,
);
