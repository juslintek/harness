import type { Database } from "bun:sqlite";

export const SECRET = "ORG-A-SECRET-MARKER";

const id = (): string => Bun.randomUUIDv7();

export interface SeedScope {
  orgId: string;
  teamId: string;
  memberId: string;
  channelId: string;
}

// Rows no route creates without a model run or a bridge client, so they go in directly.
// Every call makes a new row, so a request that consumes one never starves the next case.
export function seedHire(db: Database, s: SeedScope): { hire: string; candidate: string } {
  const hire = id();
  db.query(
    `INSERT INTO hire_requests (id, org_id, team_id, requested_by, spec, status, phase_started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'interviewing', 1, 1, 1)`,
  ).run(hire, s.orgId, s.teamId, s.memberId, JSON.stringify({ title: SECRET }));
  const profile = id();
  db.query(
    "INSERT INTO profiles (id, org_id, runtime, persona, created_at, updated_at) VALUES (?, ?, 'x', ?, 1, 1)",
  ).run(profile, s.orgId, SECRET);
  const candidate = id();
  db.query(
    "INSERT INTO hire_candidates (id, request_id, profile_id, status) VALUES (?, ?, ?, 'interviewing')",
  ).run(candidate, hire, profile);
  return { hire, candidate };
}

export function seedBudget(db: Database, s: SeedScope): string {
  const budget = id();
  db.query(
    `INSERT INTO budgets (id, org_id, scope_kind, scope_id, monthly_usd, created_by, updated_at)
     VALUES (?, ?, 'team', ?, 10, ?, 1)`,
  ).run(budget, s.orgId, budget, s.memberId);
  return budget;
}

export function seedProposal(db: Database, s: SeedScope): string {
  const proposal = id();
  db.query(
    `INSERT INTO policy_proposals (id, org_id, layer, target_id, key, value, reason, proposed_by, status, created_at)
     VALUES (?, ?, 'agent', ?, 'autonomy', '"full"', ?, ?, 'open', 1)`,
  ).run(proposal, s.orgId, s.memberId, SECRET, s.memberId);
  return proposal;
}

export function seedBridge(db: Database, s: SeedScope): string {
  const bridge = id();
  db.query(
    "INSERT INTO bridges (id, org_id, channel_id, kind, external_id, created_at) VALUES (?, ?, ?, 'slack', ?, 1)",
  ).run(bridge, s.orgId, s.channelId, `${SECRET}-${bridge}`);
  return bridge;
}

export function seedTarget(db: Database, s: SeedScope): string {
  const target = id();
  db.query(
    "INSERT INTO notify_targets (id, member_id, channel, value, created_at) VALUES (?, ?, 'email', ?, 1)",
  ).run(target, s.memberId, JSON.stringify({ to: `${SECRET}@example.test` }));
  return target;
}

export function seedLesson(db: Database, s: SeedScope, taskId: string): string {
  const lesson = id();
  db.query(
    `INSERT INTO lessons (id, task_id, org_id, author_handle, body, scope, type, confidence, status, created_at)
     VALUES (?, ?, ?, 'x', ?, 'org', 'lesson', 1, 'pending', 1)`,
  ).run(lesson, taskId, s.orgId, SECRET);
  return lesson;
}
