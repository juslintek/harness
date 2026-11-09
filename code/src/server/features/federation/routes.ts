import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { z } from "zod";
import { ensureInstance } from "../../db/db";
import { DomainError, notFound, parseBody } from "../../route-kit";
import { type AuthEnv, requireInstanceAdmin, requireStepUp } from "../auth/api";
import { createInvite } from "./invites";
import { fingerprint } from "./keys";
import { acceptPair, identity, type PairDeps, pairWith } from "./pairing";
import { listPeers, type PeerRow, revokePeer } from "./peers-repo";
import { type PeerEnv, requirePeer } from "./verify";

const pairRequest = z.object({ url: z.string().max(500), token: z.string().min(1).max(200) });

function peerView(p: PeerRow): Record<string, string | number | null> {
  return {
    id: p.id,
    name: p.name,
    url: p.url,
    fingerprint: fingerprint(p.publicKey),
    pairedAt: p.pairedAt,
    lastSeenAt: p.lastSeenAt,
    revokedAt: p.revokedAt,
  };
}

export interface FederationRouteDeps extends PairDeps {
  home: string;
}

export function federationRoutes(db: Database, deps: FederationRouteDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("*", requireInstanceAdmin);
  app.get("/identity", (c) => c.json(identity(db, deps.home)));
  app.get("/peers", (c) => c.json(listPeers(db).map(peerView)));
  app.post("/invites", requireStepUp, (c) => c.json(createInvite(db, c.get("actor").userId), 201));
  app.post("/peers/pair", requireStepUp, async (c) => {
    const body = await parseBody(c, pairRequest);
    if (body instanceof Response) return body;
    try {
      const peer = await pairWith(db, deps.home, body, deps);
      return c.json({ id: peer.instanceId, name: peer.name });
    } catch (err) {
      if (err instanceof DomainError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  app.delete("/peers/:id", requireStepUp, (c) =>
    revokePeer(db, c.req.param("id")) ? c.json({ ok: true }) : notFound(c),
  );
  return app;
}

// Public and unsigned: the one-time invite token in the body is the proof. Refusals look the same
// for a wrong, used and expired token.
function pairRoute(db: Database, home: string): Hono {
  const app = new Hono();
  app.post("/pair", async (c) => {
    const answer = acceptPair(db, home, await c.req.json().catch(() => null));
    if (answer === "invalid") return c.json({ error: "invalid body" }, 400);
    if (answer === "refused") return c.json({ error: "invite refused" }, 403);
    return c.json(answer);
  });
  return app;
}

// Everything under /federation: the unsigned pairing route first, then every route that needs a
// signed peer request.
export function peerRoutes(db: Database, home: string): Hono<PeerEnv> {
  const app = new Hono<PeerEnv>();
  app.route("/", pairRoute(db, home));
  app.use("*", requirePeer(db));
  app.get("/ping", (c) => c.json({ ok: true, instanceId: ensureInstance(db) }));
  return app;
}
