import type { Database } from "bun:sqlite";
import type { ApprovalView } from "../../../shared/runs";
import { type ChatEvent, channelMemberIds } from "../chat/api";
import { getMember, getProject, listMembers, listOrgsForUser, memberForUser } from "../orgs/api";

// The org a run belongs to, resolved like the approval routes do: the stamped org first, then
// the project's, then the member's.
export function runOrgId(db: Database, runId: string): string | null {
  const run = db
    .query<
      { org_id: string | null; member_id: string | null; project_id: string | null },
      [string]
    >("SELECT org_id, member_id, project_id FROM runs WHERE id = ?")
    .get(runId);
  if (!run) return null;
  if (run.org_id) return run.org_id;
  const project = run.project_id === null ? null : getProject(db, run.project_id);
  if (project) return project.orgId;
  return run.member_id === null ? null : (getMember(db, run.member_id)?.orgId ?? null);
}

export function orgAdmins(db: Database, orgId: string): string[] {
  return listMembers(db, orgId)
    .filter((m) => m.kind === "human" && (m.role === "owner" || m.role === "admin"))
    .map((m) => m.id);
}

// Notifications are addressed to members and the instance admin is a user. Use their seat in the
// run's org, else their oldest one, so their own preferences and targets apply.
function instanceAdminMembers(db: Database, orgId: string): string[] {
  const admins = db
    .query<{ id: string }, []>("SELECT id FROM users WHERE instance_admin = 1")
    .all();
  return admins.flatMap(({ id }) => {
    const seat =
      memberForUser(db, orgId, id) ??
      listOrgsForUser(db, id)
        .map((o) => memberForUser(db, o.id, id))
        .find((m) => m !== null);
    return seat ? [seat.id] : [];
  });
}

export function approvalRecipients(db: Database, approval: ApprovalView): string[] {
  const orgId = runOrgId(db, approval.runId);
  if (orgId === null) return [];
  return [...new Set([...instanceAdminMembers(db, orgId), ...orgAdmins(db, orgId)])];
}

export function chatRecipients(db: Database, e: ChatEvent): { dm: string[]; mention: string[] } {
  const author = e.message.authorId;
  const humans = (ids: string[]): string[] =>
    ids.filter((id) => id !== author && getMember(db, id)?.kind === "human");
  const dm = e.channel.kind === "dm" ? humans(channelMemberIds(db, e.channel.id)) : [];
  return { dm, mention: humans(e.mentions).filter((id) => !dm.includes(id)) };
}
