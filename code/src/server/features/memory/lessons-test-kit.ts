import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createTask } from "../board/api";
import {
  addAgentMember,
  addToTeam,
  createOrg,
  createPosition,
  createProject,
  listTeams,
  type MemberRow,
  memberForUser,
} from "../orgs/api";
import { drainCommits } from "./git-log";

export interface World {
  db: Database;
  home: string;
  orgId: string;
  human: { id: string };
  projectId: string;
  teamId: string;
  agent: (handle: string) => MemberRow;
  task: (title: string, assignee: MemberRow) => ReturnType<typeof createTask>;
  doneTask: (assignee: MemberRow, title?: string) => ReturnType<typeof createTask>;
  other: { orgId: string; agent: MemberRow };
}

export const GOOD = "Run `bun run check` before pushing because depcruise fails late in CI.";

export function world(): World {
  // A closed port makes the classifier fall back to its rules: project scope, no live Laya.
  process.env.OLLAYA_URL = "http://127.0.0.1:1";
  const db = openDb(":memory:");
  migrate(db, migrations);
  const home = mkdtempSync(join(tmpdir(), "harness-lessons-"));
  const mkOrg = (slug: string) =>
    createOrg(db, {
      name: slug,
      slug,
      ownerUserId: `u-${slug}`,
      ownerName: slug,
      ownerHandle: slug,
    });
  const org = mkOrg("acme");
  const beta = mkOrg("beta");
  const human = memberForUser(db, org.id, "u-acme") as MemberRow;
  const project = createProject(db, { orgId: org.id, key: "web", name: "Web" });
  const teamId = (listTeams(db, org.id)[0] as { id: string }).id;
  const agent = (handle: string): MemberRow =>
    addAgentMember(db, org.id, { agentId: "x", handle, displayName: handle, specialties: [] });
  return {
    db,
    home,
    orgId: org.id,
    human,
    projectId: project.id,
    teamId,
    agent,
    task: (title, assignee) =>
      createTask(db, {
        projectId: project.id,
        title,
        createdBy: human.id,
        assigneeId: assignee.id,
      }),
    doneTask: (assignee, title = "ship it") =>
      createTask(db, {
        projectId: project.id,
        title,
        createdBy: human.id,
        assigneeId: assignee.id,
        status: "done",
      }),
    other: {
      orgId: beta.id,
      agent: addAgentMember(db, beta.id, {
        agentId: "x",
        handle: "outsider",
        displayName: "outsider",
        specialties: [],
      }),
    },
  };
}

export async function close(w: World): Promise<void> {
  delete process.env.OLLAYA_URL;
  await drainCommits();
  w.db.close();
  rmSync(w.home, { recursive: true, force: true });
}

// A manager position the author reports to, so reviewerFor finds the manager first.
export function manage(w: World, boss: MemberRow, report: MemberRow): void {
  const top = createPosition(w.db, {
    orgId: w.orgId,
    title: "lead",
    memberId: boss.id,
    isManager: true,
  });
  createPosition(w.db, { orgId: w.orgId, title: "dev", memberId: report.id, reportsTo: top.id });
}

export function mate(w: World, a: MemberRow, b: MemberRow): void {
  addToTeam(w.db, w.teamId, a.id);
  addToTeam(w.db, w.teamId, b.id);
}
