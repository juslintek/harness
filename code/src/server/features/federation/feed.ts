import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { z } from "zod";
import { flushPending } from "./bodies";
import type { PeerEnv } from "./verify";

export const PAGE_LIMIT = 500;

type Cell = string | number | null;

export interface FeedChange {
  seq: number;
  projectId: string;
  table: string;
  rowId: string;
  op: "put" | "del";
  hlc: string;
  origin: string;
  data: Record<string, Cell> | null;
}

export interface FeedPage {
  changes: FeedChange[];
  next: number;
}

const cell: z.ZodType<Cell> = z.union([z.string(), z.number(), z.null()]);
export const feedPage: z.ZodType<FeedPage> = z.object({
  changes: z.array(
    z.object({
      seq: z.number().int(),
      projectId: z.string(),
      table: z.string(),
      rowId: z.string(),
      op: z.enum(["put", "del"]),
      hlc: z.string(),
      origin: z.string(),
      data: z.record(z.string(), cell).nullable(),
    }),
  ),
  next: z.number().int(),
});

const feedQuery = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT).default(PAGE_LIMIT),
});

interface Raw {
  seq: number;
  project_id: string;
  table_name: string;
  row_id: string;
  op: "put" | "del";
  hlc: string;
  origin_instance: string;
  data: string | null;
}

// A peer sees a project only if this instance is its home and granted it to an org of that peer, or
// the peer is the home of the copy held here. A change on a copy is never served to a third peer,
// so replication does not relay. Only the newest change of each row is served: older versions may
// hold content that was edited or deleted since, and a later grantee must not get them. Rows at or
// below the cursor cannot supersede anything newer, so the window only looks past it.
const SCOPED = `
  WITH scoped AS (
    SELECT c.*, ROW_NUMBER() OVER (
      PARTITION BY c.project_id, c.table_name, c.row_id ORDER BY c.seq DESC) AS newest
    FROM fed_changes c
    WHERE c.seq > ?1 AND (
      EXISTS (SELECT 1 FROM projects p JOIN grants g ON g.project_id = p.id JOIN orgs o ON o.id = g.org_id
              WHERE p.id = c.project_id AND p.home_instance IS NULL AND o.home_instance = ?2)
      OR EXISTS (SELECT 1 FROM projects p WHERE p.id = c.project_id AND p.home_instance = ?2)))
  SELECT seq, project_id, table_name, row_id, op, hlc, origin_instance, data
  FROM scoped WHERE newest = 1 ORDER BY seq LIMIT ?3`;

export function changesFor(db: Database, peerId: string, since: number, limit: number): FeedPage {
  const rows = db.query<Raw, [number, string, number]>(SCOPED).all(since, peerId, limit);
  return {
    changes: rows.map((r) => ({
      seq: r.seq,
      projectId: r.project_id,
      table: r.table_name,
      rowId: r.row_id,
      op: r.op,
      hlc: r.hlc,
      origin: r.origin_instance,
      data: r.data === null ? null : (JSON.parse(r.data) as Record<string, Cell>),
    })),
    next: rows.at(-1)?.seq ?? since,
  };
}

export function feedRoutes(db: Database, home: string): Hono<PeerEnv> {
  const app = new Hono<PeerEnv>();
  app.get("/changes", (c) => {
    const query = feedQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "invalid query" }, 400);
    flushPending(db, home);
    return c.json(changesFor(db, c.get("peerId"), query.data.since, query.data.limit));
  });
  return app;
}
