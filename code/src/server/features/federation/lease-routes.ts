import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { grantLease, releaseLease, writePeerNote } from "./lease";
import type { PeerEnv } from "./verify";

const leaseBody = z.object({
  taskId: z.string().min(1).max(100),
  memberId: z.string().min(1).max(100),
  ttlMs: z.number().int().positive(),
  renew: z.boolean().optional(),
});
const releaseBody = leaseBody.omit({ ttlMs: true });
const noteBody = z.object({
  noteId: z.string().min(1).max(100),
  memberId: z.string().min(1).max(100),
  baseHash: z.string().min(1).max(100),
  text: z.string().max(500_000),
  meta: z
    .object({
      type: z.enum(["lesson", "fact", "decision", "howto", "reference"]).optional(),
      tags: z.array(z.string().min(1).max(50)).max(20).optional(),
      confidence: z.number().min(0).max(1).optional(),
    })
    .default({}),
});

// The body was already read by requirePeer (it is part of the signature), so it comes from there.
function bodyOf<T>(c: Context<PeerEnv>, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(c.get("rawBody"))));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const STATUS = { forbidden: 403, not_found: 404 } as const;

// The board's own failure shape goes back whole (holderId, open tasks) so the copy can show it.
const refusal = (c: Context<PeerEnv>, answer: { ok: false; reason: string }): Response =>
  c.json(answer, STATUS[answer.reason as keyof typeof STATUS] ?? 409);

// Every refusal for a missing grant is the same bare 403, whatever was missing.
export function leaseRoutes(db: Database, home: string): Hono<PeerEnv> {
  const app = new Hono<PeerEnv>();
  app.post("/lease", (c) => {
    const body = bodyOf(c, leaseBody);
    if (body === null) return c.json({ error: "invalid body" }, 400);
    const answer = grantLease(db, c.get("peerId"), body);
    return answer.ok ? c.json({ expiresAt: answer.expiresAt }) : refusal(c, answer);
  });
  app.post("/lease/release", (c) => {
    const body = bodyOf(c, releaseBody);
    if (body === null) return c.json({ error: "invalid body" }, 400);
    const answer = releaseLease(db, c.get("peerId"), body);
    return answer.ok ? c.json({ ok: true }) : refusal(c, answer);
  });
  app.post("/note", (c) => {
    const body = bodyOf(c, noteBody);
    if (body === null) return c.json({ error: "invalid body" }, 400);
    const answer = writePeerNote(db, home, c.get("peerId"), body);
    if (answer === "forbidden") return refusal(c, { ok: false, reason: "forbidden" });
    if (answer === "conflict") return c.json({ error: "conflict" }, 409);
    return c.json({ hash: answer.hash });
  });
  return app;
}
