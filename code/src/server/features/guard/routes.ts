import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { z } from "zod";
import { decisionBody } from "../../../shared/runs";
import { approvalView, decideApproval, findApproval, listApprovals } from "./api";

const statusQuery = z.enum(["pending", "approved", "denied", "expired"]);

export function approvalRoutes(db: Database): Hono {
  const app = new Hono();
  app.get("/", (c) => {
    const raw = c.req.query("status");
    const status = raw === undefined ? undefined : statusQuery.safeParse(raw);
    if (status && !status.success) return c.json({ error: "invalid status" }, 400);
    return c.json(listApprovals(db, status?.data).map(approvalView));
  });
  app.post("/:id", async (c) => {
    const body = decisionBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const id = c.req.param("id");
    if (!findApproval(db, id)) return c.json({ error: "unknown approval" }, 404);
    if (!decideApproval(db, id, body.data.decision, "admin")) {
      return c.json({ error: "not pending" }, 409);
    }
    const row = findApproval(db, id);
    return c.json(row ? approvalView(row) : { ok: true });
  });
  return app;
}
