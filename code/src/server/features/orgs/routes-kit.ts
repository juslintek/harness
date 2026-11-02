import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import type { OrgView, Role } from "../../../shared/orgs";
import { forbidden, notFound } from "../../route-kit";
import { type AuthEnv, hasFreshStepUp, stepUpRequired } from "../auth/api";
import { getOrgBySlug, type MemberRow, memberForUser, roleAtLeast } from "./api";

export interface OrgCtx {
  org: OrgView;
  member: MemberRow;
}

// Strangers get 404 so slugs do not leak; a member below `min` gets 403.
export function resolveOrg(
  db: Database,
  c: Context<AuthEnv>,
  min: Role = "viewer",
): OrgCtx | Response {
  const org = getOrgBySlug(db, c.req.param("org") ?? "");
  const member = org ? memberForUser(db, org.id, c.get("actor").userId) : null;
  if (!org || !member) return notFound(c);
  return roleAtLeast(member.role, min) ? { org, member } : forbidden(c);
}

export function needStepUp(c: Context<AuthEnv>): Response | null {
  return hasFreshStepUp(c.get("actor")) ? null : stepUpRequired(c);
}
