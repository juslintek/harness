import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { z } from "zod";
import { decisionBody } from "../../../shared/runs";
import { forbidden } from "../../route-kit";
import { type AuthEnv, requireStepUp } from "../auth/api";
import { getMember, getProject, listOrgsForUser, orgAccess, roleAtLeast } from "../orgs/api";
import { type ApprovalRow, approvalView, decideApproval, findApproval, listApprovals } from "./api";
import { orgAdminRefusal } from "./manager-limits";

const statusQuery = z.enum(["pending", "approved", "denied", "expired"]);

function administeredOrgs(db: Database, userId: string): Set<string> {
  const admin = (orgId: string): boolean => {
    const role = orgAccess(db, userId, orgId);
    return role !== null && roleAtLeast(role, "admin");
  };
  return new Set(
    listOrgsForUser(db, userId)
      .map((o) => o.id)
      .filter(admin),
  );
}

// A run in a project works in that project's repo, so the org owning the project decides, not a
// grantee org whose agent happens to run there.
function runOrg(db: Database, runId: string): string | null {
  const run = db
    .query<{ member_id: string | null; project_id: string | null }, [string]>(
      "SELECT member_id, project_id FROM runs WHERE id = ?",
    )
    .get(runId);
  if (!run?.member_id) return null;
  const project = run.project_id === null ? null : getProject(db, run.project_id);
  return project?.orgId ?? getMember(db, run.member_id)?.orgId ?? null;
}

// The instance admin sees everything; an org owner or admin sees the runs of its own members.
function mayDecide(
  db: Database,
  actor: AuthEnv["Variables"]["actor"],
  approval: ApprovalRow,
): boolean {
  if (actor.instanceAdmin) return true;
  const orgId = runOrg(db, approval.runId);
  return orgId !== null && administeredOrgs(db, actor.userId).has(orgId);
}

export function approvalRoutes(db: Database, harnessHome: string): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  // Someone who administers no org has nothing to do here, whatever they send.
  app.use("*", async (c, next) => {
    const actor = c.get("actor");
    if (!actor.instanceAdmin && administeredOrgs(db, actor.userId).size === 0) return forbidden(c);
    await next();
  });
  app.get("/", (c) => {
    const raw = c.req.query("status");
    const status = raw === undefined ? undefined : statusQuery.safeParse(raw);
    if (status && !status.success) return c.json({ error: "invalid status" }, 400);
    const actor = c.get("actor");
    const orgs = actor.instanceAdmin ? null : administeredOrgs(db, actor.userId);
    const rows = listApprovals(db, status?.data).filter((a) => {
      if (orgs === null) return true;
      const orgId = runOrg(db, a.runId);
      return orgId !== null && orgs.has(orgId);
    });
    return c.json(rows.map(approvalView));
  });
  app.post("/:id", requireStepUp, async (c) => {
    const body = decisionBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const id = c.req.param("id");
    const approval = findApproval(db, id);
    if (!approval) return c.json({ error: "unknown approval" }, 404);
    const actor = c.get("actor");
    if (!mayDecide(db, actor, approval)) return forbidden(c);
    const refusal = actor.instanceAdmin ? null : orgAdminRefusal(approval, harnessHome);
    if (refusal !== null) return c.json({ error: "instance_admin_required", reason: refusal }, 403);
    if (!decideApproval(db, id, body.data.decision, `user:${actor.userId}`)) {
      return c.json({ error: "not pending" }, 409);
    }
    const row = findApproval(db, id);
    return c.json(row ? approvalView(row) : { ok: true });
  });
  return app;
}
