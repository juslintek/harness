// Scenario setup for the Phase 2 gate: scratch repo, org, agents, positions and project.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { openDb } from "../src/server/db/db";

type Db = ReturnType<typeof openDb>;

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

export function git(args: string[], cwd: string): string {
  const res = Bun.spawnSync(
    ["git", "-c", "user.name=gate", "-c", "user.email=gate@test", ...args],
    {
      cwd,
    },
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
  const core = listTeams(db, org.id).find((t) => t.name === "Core");
  if (!core) throw new Error("no Core team");
  const agent = (agentId: string, handle: string, title: string): MemberRow =>
    addAgentMember(db, org.id, { agentId, handle, displayName: title, specialties: [] });
  const lead = agent("claude", "lead", "Lead");
  const dev = agent("codex", "dev", "Dev");
  for (const m of [lead, dev]) addToTeam(db, core.id, m.id);
  const leadPos = createPosition(db, {
    orgId: org.id,
    teamId: core.id,
    title: "Tech lead",
    memberId: lead.id,
    isManager: true,
  });
  createPosition(db, {
    orgId: org.id,
    teamId: core.id,
    title: "Developer",
    memberId: dev.id,
    reportsTo: leadPos.id,
  });
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
