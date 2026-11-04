import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import type { z } from "zod";
import type { Role } from "../../../shared/orgs";
import { forbidden, notFound, parseBody, routeError } from "../../route-kit";
import type { AuthEnv } from "../auth/api";
import { classifyNote } from "../laya/api";
import { getOrgBySlug, memberForUser, roleAtLeast } from "../orgs/api";
import type { Viewer } from "./paths";
import { MemoryError, type MemoryErrorCode, type WriteCtx } from "./store-kit";
import { humanViewer } from "./viewer";

const STATUS: Record<MemoryErrorCode, 400 | 403 | 404 | 409> = {
  not_found: 404,
  conflict: 409,
  forbidden: 403,
  invalid: 400,
  exists: 409,
};

export function memoryError(err: Error, c: Context): Response {
  if (!(err instanceof MemoryError)) return routeError(err, c);
  return c.json({ error: err.code, message: err.message }, STATUS[err.code]);
}

export interface MemoryCtx {
  orgId: string;
  viewer: Viewer;
  write: WriteCtx;
  userId: string;
}

// The viewer is rebuilt from the session and the member row on every request, never from client input.
export function memoryCtx(db: Database, c: Context<AuthEnv>, min: Role): MemoryCtx | Response {
  const actor = c.get("actor");
  const org = getOrgBySlug(db, c.req.param("org") ?? "");
  const member = org ? memberForUser(db, org.id, actor.userId) : null;
  // Strangers get 404 so slugs do not leak; a member below `min` gets 403.
  if (!org || !member) return notFound(c);
  if (!roleAtLeast(member.role, min)) return forbidden(c);
  const viewer = humanViewer(db, org.id, actor.userId, actor.instanceAdmin);
  return {
    orgId: org.id,
    viewer,
    userId: actor.userId,
    write: {
      viewer,
      runId: null,
      classify: classifyNote,
      refreshViewer: () => {
        try {
          return humanViewer(db, org.id, actor.userId, actor.instanceAdmin);
        } catch {
          return null;
        }
      },
    },
  };
}

// The role is checked again once the body has been read: parsing can take as long as the client
// likes to stream it, and a member demoted in that time must not write with the old role.
export async function memoryBody<T>(
  db: Database,
  c: Context<AuthEnv>,
  min: Role,
  schema: z.ZodType<T>,
): Promise<{ m: MemoryCtx; b: T } | Response> {
  const early = memoryCtx(db, c, min);
  if (early instanceof Response) return early;
  const b = await parseBody(c, schema);
  if (b instanceof Response) return b;
  const m = memoryCtx(db, c, min);
  return m instanceof Response ? m : { m, b };
}
