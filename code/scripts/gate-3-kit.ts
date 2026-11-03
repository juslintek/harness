// Scenario setup and reads for the Phase 3 gate: scratch repo, org gate3, @lead, @dev, policy.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { openDb } from "../src/server/db/db";
import { listAgents, refreshModels, setLinked } from "../src/server/features/agents/api";
import { createSession, createUser } from "../src/server/features/auth/api";
import { ensureProjectChannel } from "../src/server/features/chat/api";
import {
  addAgentMember,
  addToTeam,
  createOrg,
  createPosition,
  createProject,
  listTeams,
  type MemberRow,
} from "../src/server/features/orgs/api";
import { setPolicy } from "../src/server/features/policies/api";
import { ensureProfile, submitCard } from "../src/server/features/profiles/api";
import { refreshAcpModels } from "../src/server/features/runtimes/api";
import type { createApp } from "../src/server/http";
import type { DashboardView } from "../src/shared/tracking";
import { git } from "./gate-2-kit";

type Db = ReturnType<typeof openDb>;

export interface Scene {
  orgId: string;
  userId: string;
  projectId: string;
  channelId: string;
  repo: string;
  owner: string;
  lead: MemberRow;
  dev: MemberRow;
  taskId: string;
}

function scratchRepo(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "db"), { recursive: true });
  git(["init", "-q", "-b", "main"], repo);
  writeFileSync(
    join(repo, "package.json"),
    `${JSON.stringify({ name: "g3", private: true, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(join(repo, "db", ".gitkeep"), "");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);
  return repo;
}

// The cheapest listed Claude model is the one with "haiku" in its id or name; null leaves the default.
async function cheapestClaudeModel(db: Db): Promise<string | null> {
  const claude = (await listAgents(db)).find((a) => a.id === "claude");
  const haiku = claude?.models.find((m) => /haiku/i.test(`${m.id} ${m.name}`));
  return haiku?.id ?? null;
}

export async function pickLeadModel(
  db: Db,
  runDeps: { home: string; port: number },
): Promise<string | null> {
  await refreshModels(db, "claude", { listAcp: (spec) => refreshAcpModels(runDeps, spec) }).catch(
    (err: unknown) => console.error("claude model list unavailable, using the default", err),
  );
  const leadModel = await cheapestClaudeModel(db);
  console.log(`@lead model: ${leadModel ?? "default (no haiku listed)"}`);
  return leadModel;
}

function addPair(
  db: Db,
  orgId: string,
  leadModel: string | null,
): { lead: MemberRow; dev: MemberRow } {
  // The router only runs agents a person has linked, as the one-click link in the UI would.
  for (const id of ["claude", "codex"]) setLinked(db, id, true);
  const lead = addAgentMember(db, orgId, {
    agentId: "claude",
    handle: "lead",
    displayName: "Lead",
    specialties: [],
    ...(leadModel === null ? {} : { model: leadModel }),
  });
  const dev = addAgentMember(db, orgId, {
    agentId: "codex",
    handle: "dev",
    displayName: "Dev",
    specialties: ["frontend"],
  });
  return { lead, dev };
}

function placeInTeam(
  db: Db,
  p: { orgId: string; teamId: string; lead: MemberRow; dev: MemberRow },
): void {
  for (const m of [p.lead, p.dev]) addToTeam(db, p.teamId, m.id);
  const leadPos = createPosition(db, {
    orgId: p.orgId,
    teamId: p.teamId,
    title: "Tech lead",
    memberId: p.lead.id,
    isManager: true,
  });
  createPosition(db, {
    orgId: p.orgId,
    teamId: p.teamId,
    title: "Developer",
    memberId: p.dev.id,
    reportsTo: leadPos.id,
  });
}

// The card is what the router and hiring read; @dev declares frontend only, so the team lacks database.
function giveDevCard(db: Db, lead: MemberRow, dev: MemberRow): void {
  const card = submitCard(db, ensureProfile(db, dev.id).id, {
    summary: "Frontend developer: components, styling and browser tests.",
    specialties: ["frontend"],
    strengths: ["UI components", "CSS"],
    limits: ["no database work"],
    preferredTaskTypes: ["feature"],
  });
  if (!card.ok) throw new Error(`dev card rejected: ${card.issues.join("; ")}`);
  ensureProfile(db, lead.id);
}

export function build(db: Db, root: string, leadModel: string | null): Scene {
  const repo = scratchRepo(root);
  const userId = createUser(db, { email: "gate3@test.local", name: "Gate", instanceAdmin: true });
  const org = createOrg(db, {
    name: "Gate 3",
    slug: "gate3",
    ownerUserId: userId,
    ownerName: "Gate",
    ownerHandle: "gate",
  });
  const core = listTeams(db, org.id).find((t) => t.name === "Core");
  if (!core) throw new Error("no Core team");
  const { lead, dev } = addPair(db, org.id, leadModel);
  placeInTeam(db, { orgId: org.id, teamId: core.id, lead, dev });
  const owner = db
    .query<{ id: string }, [string]>("SELECT id FROM members WHERE user_id = ?")
    .get(userId)?.id;
  if (!owner) throw new Error("no owner member");
  giveDevCard(db, lead, dev);
  const set = setPolicy(db, {
    layer: "org",
    targetId: org.id,
    key: "hiring.decision",
    // @lead files the hire and has nobody above it, and a requester never decides its own
    // request, so the scorecard decides.
    value: "auto",
    setBy: owner,
  });
  if (!set.ok) throw new Error(`policy refused: ${set.reason}`);
  const project = createProject(db, {
    orgId: org.id,
    teamId: core.id,
    key: "G3",
    name: "G3",
    repo,
  });
  const channel = ensureProjectChannel(db, project.id);
  return {
    orgId: org.id,
    userId,
    projectId: project.id,
    channelId: channel.id,
    repo,
    owner,
    lead,
    dev,
    taskId: "",
  };
}

export function claudeSpendUsd(db: Db): number {
  const row = db
    .query<{ usd: number }, []>(
      "SELECT COALESCE(sum(reported_cost_usd), 0) AS usd FROM events WHERE kind = 'usage' AND agent = 'claude'",
    )
    .get();
  return row?.usd ?? 0;
}

export function hiredMemberId(db: Db, orgId: string): string | null {
  const row = db
    .query<{ hired_member_id: string | null }, [string]>(
      "SELECT hired_member_id FROM hire_requests WHERE org_id = ? AND status = 'hired' LIMIT 1",
    )
    .get(orgId);
  return row?.hired_member_id ?? null;
}

export function hireStatuses(db: Db, orgId: string): string[] {
  return db
    .query<{ status: string }, [string]>(
      "SELECT status FROM hire_requests WHERE org_id = ? ORDER BY created_at",
    )
    .all(orgId)
    .map((r) => r.status);
}

interface HandoffRow {
  reason: string;
  fromAgent: string;
  toAgent: string | null;
  fromWorktree: string | null;
  toWorktree: string | null;
}

export function handoffs(db: Db): HandoffRow[] {
  return db
    .query<
      {
        reason: string;
        from_agent: string;
        to_agent: string | null;
        from_worktree: string | null;
        to_worktree: string | null;
      },
      []
    >(
      `SELECT h.reason, f.agent_id AS from_agent, t.agent_id AS to_agent,
         f.worktree AS from_worktree, t.worktree AS to_worktree
       FROM run_handoffs h JOIN runs f ON f.id = h.from_run_id LEFT JOIN runs t ON t.id = h.to_run_id
       ORDER BY h.created_at`,
    )
    .all()
    .map((r) => ({
      reason: r.reason,
      fromAgent: r.from_agent,
      toAgent: r.to_agent,
      fromWorktree: r.from_worktree,
      toWorktree: r.to_worktree,
    }));
}

export function writeTimeline(home: string, lines: string[]): void {
  writeFileSync(join(home, "timeline.txt"), `${lines.join("\n")}\n`);
}

// Calls the real route with a session written straight to the db, as the browser would.
export async function dashboard(
  db: Db,
  s: Scene,
  app: ReturnType<typeof createApp>,
  port: number,
): Promise<DashboardView> {
  const origin = `http://localhost:${port}`;
  const { token } = createSession(db, s.userId, "passkey", null);
  const res = await app.fetch(
    new Request(`${origin}/api/orgs/gate3/dashboard?since=0`, {
      headers: { cookie: `harness_session=${token}`, host: `localhost:${port}`, origin },
    }),
  );
  if (res.status !== 200) throw new Error(`dashboard answered ${res.status}`);
  return (await res.json()) as DashboardView;
}
