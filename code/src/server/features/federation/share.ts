import type { Database } from "bun:sqlite";
import { DomainError } from "../../route-kit";
import { ensureRemoteOrg, findRemoteOrg, grantProject, revokeGrant } from "../orgs/api";
import { getPeer } from "./peers-repo";

export interface ShareView {
  projectId: string;
  projectName: string;
  peerId: string;
  peerName: string | null;
  permission: "read" | "write";
}

// Every row of the project, for the peer's first pull. Triggers only see writes made after the
// grant exists, so without this the peer would learn the grant and nothing else. Parents come
// from the same project (orgs and members of its orgs), the rest hang off it.
const SEED: readonly string[] = [
  "SELECT 'orgs', org_id, 'put', NULL FROM fed_scope WHERE project_id = ?1",
  `SELECT 'members', m.id, 'put', NULL FROM members m
   WHERE m.org_id IN (SELECT org_id FROM fed_scope WHERE project_id = ?1)
     AND m.id IN (
       SELECT assignee_id FROM tasks WHERE project_id = ?1
       UNION SELECT holder_id FROM tasks WHERE project_id = ?1
       UNION SELECT c.author_id FROM comments c JOIN tasks t ON t.id = c.task_id WHERE t.project_id = ?1
       UNION SELECT x.author_id FROM messages x JOIN channels ch ON ch.id = x.channel_id
             WHERE ch.project_id = ?1 AND ch.kind = 'project')`,
  "SELECT 'projects', id, 'put', id FROM projects WHERE id = ?1",
  "SELECT 'grants', id, 'put', project_id FROM grants WHERE project_id = ?1",
  "SELECT 'tasks', id, 'put', project_id FROM tasks WHERE project_id = ?1",
  `SELECT 'task_deps', d.task_id || ':' || d.depends_on, 'put', t.project_id
   FROM task_deps d JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ?1`,
  `SELECT 'comments', c.id, 'put', t.project_id
   FROM comments c JOIN tasks t ON t.id = c.task_id WHERE t.project_id = ?1`,
  "SELECT 'channels', id, 'put', project_id FROM channels WHERE project_id = ?1 AND kind = 'project'",
  `SELECT 'messages', x.id, 'put', ch.project_id
   FROM messages x JOIN channels ch ON ch.id = x.channel_id
   WHERE ch.project_id = ?1 AND ch.kind = 'project'`,
  "SELECT 'notes', id, 'put', project_id FROM notes WHERE project_id = ?1 AND scope = 'project'",
];

function markProjectDirty(db: Database, projectId: string): void {
  for (const select of SEED) {
    db.run(`INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) ${select}`, [
      projectId,
    ]);
  }
}

function isHomeProject(db: Database, projectId: string): boolean {
  return (
    db.query("SELECT 1 FROM projects WHERE id = ? AND home_instance IS NULL").get(projectId) !==
    null
  );
}

// The peer gets a stub org here and a grant to it, the same shape as a local grant, so access
// rules and listings stay in the orgs slice.
export function shareProject(
  db: Database,
  projectId: string,
  peerId: string,
  permission: ShareView["permission"],
  grantedBy: string,
): void {
  const peer = getPeer(db, peerId);
  if (!peer || peer.revokedAt !== null) throw new DomainError("unknown peer");
  if (!isHomeProject(db, projectId))
    throw new DomainError("only the home instance shares a project");
  db.transaction(() => {
    grantProject(db, projectId, ensureRemoteOrg(db, peerId, peer.name), permission, grantedBy);
    markProjectDirty(db, projectId);
  })();
}

// Revoking only stops the feed: the peer keeps the copy it already pulled, because this instance
// cannot reach into another one's database. Delete on the peer's side if that matters.
export function unshareProject(db: Database, projectId: string, peerId: string): boolean {
  const orgId = findRemoteOrg(db, peerId);
  const held =
    orgId !== null &&
    db.query("SELECT 1 FROM grants WHERE project_id = ? AND org_id = ?").get(projectId, orgId) !==
      null;
  if (orgId === null || !held) return false;
  revokeGrant(db, projectId, orgId);
  return true;
}

export function listShares(
  db: Database,
  canAdminister: (projectId: string) => boolean,
): ShareView[] {
  const rows = db
    .query<
      { project_id: string; project_name: string; peer_id: string; permission: "read" | "write" },
      []
    >(
      `SELECT g.project_id, p.name AS project_name, o.home_instance AS peer_id, g.permission
       FROM grants g JOIN orgs o ON o.id = g.org_id JOIN projects p ON p.id = g.project_id
       WHERE o.home_instance IS NOT NULL AND p.home_instance IS NULL
       ORDER BY g.created_at, g.id`,
    )
    .all();
  return rows
    .filter((r) => canAdminister(r.project_id))
    .map((r) => ({
      projectId: r.project_id,
      projectName: r.project_name,
      peerId: r.peer_id,
      peerName: getPeer(db, r.peer_id)?.name ?? null,
      permission: r.permission,
    }));
}
