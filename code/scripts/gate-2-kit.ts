// Scenario setup for the Phase 2 gate: scratch repo, org, agents, positions and project.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { openDb } from "../src/server/db/db";
import { gitEnv } from "../src/server/git-env";

type Db = ReturnType<typeof openDb>;

import { setLinked } from "../src/server/features/agents/api";
import { createUser } from "../src/server/features/auth/api";
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
import { gateAgentIds, leadAgentId } from "./gate-engine";

export function git(args: string[], cwd: string): string {
  const res = Bun.spawnSync(
    ["git", "-c", "user.name=gate", "-c", "user.email=gate@test", ...args],
    { cwd, env: gitEnv() },
  );
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
  return res.stdout.toString().trim();
}

export interface Scene {
  orgId: string;
  projectId: string;
  channelId: string;
  repo: string;
  owner: MemberRow;
  lead: MemberRow;
  dev: MemberRow;
  taskId: string;
}

function scratchRepo(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, "math.ts"), "export {};\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);
  return repo;
}

function seedPositions(db: Db, orgId: string, teamId: string, leadId: string, devId: string): void {
  const leadPos = createPosition(db, {
    orgId,
    teamId,
    title: "Tech lead",
    memberId: leadId,
    isManager: true,
  });
  createPosition(db, {
    orgId,
    teamId,
    title: "Developer",
    memberId: devId,
    reportsTo: leadPos.id,
  });
}

export function build(db: Db, root: string): Scene {
  const repo = scratchRepo(root);
  const userId = createUser(db, { email: "gate@test.local", name: "Gate", instanceAdmin: true });
  const org = createOrg(db, {
    name: "Gate Org",
    slug: "gate",
    ownerUserId: userId,
    ownerName: "Gate",
    ownerHandle: "gate",
  });
  // The router only runs agents a person has linked, as the one-click link in the UI would.
  for (const id of gateAgentIds()) setLinked(db, id, true);
  const core = listTeams(db, org.id).find((t) => t.name === "Core");
  if (!core) throw new Error("no Core team");
  const agent = (agentId: string, handle: string, title: string): MemberRow =>
    addAgentMember(db, org.id, { agentId, handle, displayName: title, specialties: [] });
  const lead = agent(leadAgentId(), "lead", "Lead");
  const dev = agent("codex", "dev", "Dev");
  for (const m of [lead, dev]) addToTeam(db, core.id, m.id);
  seedPositions(db, org.id, core.id, lead.id, dev.id);
  const project = createProject(db, {
    orgId: org.id,
    teamId: core.id,
    key: "GATE",
    name: "GATE",
    repo,
  });
  const channel = ensureProjectChannel(db, project.id);
  const owner = db
    .query<{ id: string }, [string]>("SELECT id FROM members WHERE user_id = ?")
    .get(userId);
  return {
    orgId: org.id,
    projectId: project.id,
    channelId: channel.id,
    repo,
    owner: { id: owner?.id ?? "" } as MemberRow,
    lead,
    dev,
    taskId: "",
  };
}
