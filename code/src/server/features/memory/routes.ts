import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { z } from "zod";
import { parseQuery } from "../../route-kit";
import type { AuthEnv } from "../auth/api";
import { toSummary } from "./index-repo";
import { backlinks, facets, resolveWikilink, searchNotes } from "./index-search";
import { diskToLocated, toDisk } from "./paths";
import { saveNote } from "./remote";
import { memoryBody, memoryCtx, memoryError } from "./routes-kit";
import { writeAndLessonRoutes } from "./routes-lessons";
import { createNote, deleteNote, readNote } from "./store";
import { locate, MemoryError } from "./store-kit";

const scope = z.enum(["global", "org", "project", "agent"]);
const type = z.enum(["lesson", "fact", "decision", "howto", "reference"]);
const tags = z.array(z.string().min(1).max(50)).max(20);

const listQuery = z.object({
  q: z.string().optional(),
  scope: scope.optional(),
  type: type.optional(),
  tag: z.string().optional(),
  source: z.string().optional(),
  project: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const linkQuery = z.object({ target: z.string().min(1).max(200) });
const createBody = z.object({
  scope: z.enum(["global", "org", "project"]),
  projectId: z.string().optional(),
  rel: z.string().max(200),
  body: z.string(),
  type: type.optional(),
  tags: tags.optional(),
});
const updateBody = z.object({
  baseHash: z.string(),
  body: z.string(),
  type: type.optional(),
  tags: tags.optional(),
});

const base = "/orgs/:org/memory";

function readRoutes(db: Database, home: string, app: Hono<AuthEnv>): void {
  app.get(`${base}/notes`, (c) => {
    const m = memoryCtx(db, c, "viewer");
    if (m instanceof Response) return m;
    const q = parseQuery(c, listQuery);
    if (q instanceof Response) return q;
    const hits = searchNotes(db, m.viewer, {
      ...(q.q !== undefined && { text: q.q }),
      ...(q.scope && { scope: q.scope }),
      ...(q.type && { type: q.type }),
      ...(q.tag && { tag: q.tag }),
      ...(q.source && { sourceAgent: q.source }),
      ...(q.project && { projectId: q.project }),
      ...(q.limit !== undefined && { limit: q.limit }),
    });
    return c.json(hits.map(toSummary));
  });
  app.get(`${base}/facets`, (c) => {
    const m = memoryCtx(db, c, "viewer");
    return m instanceof Response ? m : c.json(facets(db, m.viewer));
  });
  app.get(`${base}/notes/:id`, (c) => {
    const m = memoryCtx(db, c, "viewer");
    return m instanceof Response ? m : c.json(readNote(db, home, m.viewer, c.req.param("id")));
  });
  app.get(`${base}/notes/:id/backlinks`, (c) => {
    const m = memoryCtx(db, c, "viewer");
    if (m instanceof Response) return m;
    const { note } = locate(db, m.viewer, c.req.param("id"));
    return c.json(backlinks(db, m.viewer, note.id).map(toSummary));
  });
  // Resolved here because only the server knows every note this viewer may see; a search hit list
  // can miss the target and has no notion of the source note's directory.
  app.get(`${base}/notes/:id/link`, (c) => {
    const m = memoryCtx(db, c, "viewer");
    if (m instanceof Response) return m;
    const q = parseQuery(c, linkQuery);
    if (q instanceof Response) return q;
    const { note } = locate(db, m.viewer, c.req.param("id"));
    const hit = resolveWikilink(db, m.viewer, q.target, note.disk);
    return hit === null ? c.json({ error: "not_found" }, 404) : c.json(toSummary(hit));
  });
}

function writeRoutes(db: Database, home: string, app: Hono<AuthEnv>): void {
  app.post(`${base}/notes`, async (c) => {
    const r = await memoryBody(db, c, "member", createBody);
    if (r instanceof Response) return r;
    const { m, b } = r;
    const loc = diskToLocated(
      toDisk({
        scope: b.scope,
        orgId: b.scope === "global" ? null : m.orgId,
        projectId: b.scope === "project" ? (b.projectId ?? null) : null,
        memberId: null,
        rel: b.rel,
      }),
    );
    if (loc === null) return c.json({ error: "invalid path" }, 400);
    const meta = { ...(b.type && { type: b.type }), ...(b.tags && { tags: b.tags }) };
    return c.json(await createNote(db, home, m.write, loc, b.body, meta), 201);
  });
  app.put(`${base}/notes/:id`, async (c) => {
    const r = await memoryBody(db, c, "member", updateBody);
    if (r instanceof Response) return r;
    const { m, b } = r;
    const id = c.req.param("id");
    const meta = { ...(b.type && { type: b.type }), ...(b.tags && { tags: b.tags }) };
    try {
      return c.json(await saveNote(db, home, m.write, id, b.baseHash, b.body, meta));
    } catch (e) {
      if (e instanceof MemoryError && e.code === "conflict") {
        return c.json({ error: "conflict", hash: readNote(db, home, m.viewer, id).hash }, 409);
      }
      throw e;
    }
  });
  app.delete(`${base}/notes/:id`, (c) => {
    const m = memoryCtx(db, c, "member");
    if (m instanceof Response) return m;
    const baseHash = c.req.query("baseHash");
    if (!baseHash) return c.json({ error: "invalid query" }, 400);
    deleteNote(db, home, m.write, c.req.param("id"), baseHash);
    return c.json({ ok: true });
  });
}

export function memoryRoutes(db: Database, home: string): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.onError(memoryError);
  readRoutes(db, home, app);
  writeRoutes(db, home, app);
  writeAndLessonRoutes(db, home, app);
  return app;
}
