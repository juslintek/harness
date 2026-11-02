import type { Database } from "bun:sqlite";
import { isAbsolute } from "node:path";
import { gitEnv } from "../../git-env";

export interface ProjectRow {
  id: string;
  orgId: string;
  teamId: string | null;
  key: string;
  name: string;
  repo: string | null;
  createdAt: number;
}
export interface GrantRow {
  id: string;
  projectId: string;
  orgId: string;
  permission: "read" | "write";
  grantedBy: string;
  createdAt: number;
}

type Raw = Record<string, string | number | null>;

const projectRow = (r: Raw): ProjectRow => ({
  id: r.id as string,
  orgId: r.org_id as string,
  teamId: r.team_id as string | null,
  key: r.key as string,
  name: r.name as string,
  repo: r.repo as string | null,
  createdAt: r.created_at as number,
});

export function getProject(db: Database, id: string): ProjectRow | null {
  const r = db.query<Raw, [string]>("SELECT * FROM projects WHERE id = ?").get(id);
  return r ? projectRow(r) : null;
}

export interface NewProject {
  orgId: string;
  teamId?: string;
  key: string;
  name: string;
  repo?: string;
}
export function createProject(db: Database, input: NewProject): ProjectRow {
  if (input.repo !== undefined) assertGitRepo(input.repo);
  const id = Bun.randomUUIDv7();
  db.query(
    "INSERT INTO projects (id, org_id, team_id, key, name, repo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    input.orgId,
    input.teamId ?? null,
    input.key,
    input.name,
    input.repo ?? null,
    Date.now(),
  );
  return getProject(db, id) as ProjectRow;
}

function assertGitRepo(repo: string): void {
  if (!isAbsolute(repo)) throw new Error(`repo must be an absolute path: ${repo}`);
  const r = Bun.spawnSync(["git", "-C", repo, "rev-parse", "--git-dir"], {
    env: gitEnv(),
    stdout: "ignore",
    stderr: "ignore",
  });
  if (r.exitCode !== 0) throw new Error(`not a git repo: ${repo}`);
}

export function listProjects(db: Database, orgId: string): ProjectRow[] {
  return db
    .query<Raw, [string, string]>(
      `SELECT * FROM projects WHERE org_id = ?
       UNION SELECT p.* FROM projects p JOIN grants g ON g.project_id = p.id WHERE g.org_id = ?
       ORDER BY created_at, id`,
    )
    .all(orgId, orgId)
    .map(projectRow);
}

export function grantProject(
  db: Database,
  projectId: string,
  granteeOrgId: string,
  permission: GrantRow["permission"],
  grantedBy: string,
): void {
  db.query(
    `INSERT INTO grants (id, project_id, org_id, permission, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, org_id) DO UPDATE SET permission = excluded.permission, granted_by = excluded.granted_by`,
  ).run(Bun.randomUUIDv7(), projectId, granteeOrgId, permission, grantedBy, Date.now());
}
export function revokeGrant(db: Database, projectId: string, granteeOrgId: string): void {
  db.query("DELETE FROM grants WHERE project_id = ? AND org_id = ?").run(projectId, granteeOrgId);
}

export function listGrantOrgIds(db: Database, projectId: string): string[] {
  return db
    .query<{ org_id: string }, [string]>("SELECT org_id FROM grants WHERE project_id = ?")
    .all(projectId)
    .map((r) => r.org_id);
}
