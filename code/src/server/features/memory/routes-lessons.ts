import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { z } from "zod";
import { parseBody, parseQuery } from "../../route-kit";
import type { AuthEnv } from "../auth/api";
import { getTask } from "../board/api";
import { getWrite, listWrites } from "./index-log";
import { listLessons } from "./lessons";
import { decideLesson } from "./lessons-decide";
import { canRead, diskToLocated } from "./paths";
import { memoryCtx } from "./routes-kit";
import { MemoryError } from "./store-kit";
import { revertWrite } from "./store-revert";

const base = "/orgs/:org/memory";

const writesQuery = z.object({
  agentsOnly: z.enum(["0", "1"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const lessonsQuery = z.object({ status: z.enum(["pending", "accepted", "rejected"]).optional() });
const decideBody = z.object({
  decision: z.enum(["accept", "reject"]),
  reason: z.string().max(500),
  body: z.string().optional(),
});

export function writeAndLessonRoutes(db: Database, home: string, app: Hono<AuthEnv>): void {
  // The feed is for human org members; a write the viewer cannot read is left out, so a project
  // they lack access to does not leak through its history. Text columns are already redacted.
  app.get(`${base}/writes`, (c) => {
    const m = memoryCtx(db, c, "member");
    if (m instanceof Response) return m;
    const q = parseQuery(c, writesQuery);
    if (q instanceof Response) return q;
    const rows = listWrites(db, m.orgId, {
      limit: q.limit ?? 50,
      agentsOnly: q.agentsOnly === "1",
      includeGlobal: m.viewer.canWriteGlobal,
      viewer: m.viewer,
    });
    const out = [];
    for (const w of rows) {
      const loc = diskToLocated(w.path);
      if (loc === null || !canRead(m.viewer, loc)) continue;
      const full = getWrite(db, m.orgId, w.id, m.viewer.canWriteGlobal);
      out.push({ ...w, before: full?.beforeText ?? null, after: full?.afterText ?? null });
    }
    return c.json(out);
  });
  app.post(`${base}/writes/:id/revert`, (c) => {
    const m = memoryCtx(db, c, "member");
    return m instanceof Response ? m : c.json(revertWrite(db, home, m.write, c.req.param("id")));
  });
  app.get(`${base}/lessons`, (c) => {
    const m = memoryCtx(db, c, "member");
    if (m instanceof Response) return m;
    const q = parseQuery(c, lessonsQuery);
    if (q instanceof Response) return q;
    const visible = listLessons(db, m.orgId, q.status).filter(
      (l) => l.projectId === null || m.viewer.projectIds.includes(l.projectId),
    );
    return c.json(
      visible.map((l) => {
        const t = getTask(db, l.taskId);
        return { ...l, task: t && { number: t.number, projectId: t.projectId, title: t.title } };
      }),
    );
  });
  app.post(`${base}/lessons/:id`, async (c) => {
    const m = memoryCtx(db, c, "admin");
    if (m instanceof Response) return m;
    const b = await parseBody(c, decideBody);
    if (b instanceof Response) return b;
    const id = c.req.param("id");
    // The lesson must belong to this org, or an admin of org A could decide org B's.
    if (!listLessons(db, m.orgId).some((l) => l.id === id)) {
      throw new MemoryError("not_found", "no such lesson");
    }
    const by = { memberId: null, userId: m.userId };
    return c.json(await decideLesson(db, home, id, by, b.decision, b.reason, b.body));
  });
}
