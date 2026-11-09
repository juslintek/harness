import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import type { AuthEnv } from "../auth/api";
import { consumePairInvite as consumeInviteFile } from "./invites";
import { type PairAnswer, type PairDeps, pairWith as pair } from "./pairing";
import {
  type FederationRouteDeps,
  peerRoutes as publicPeer,
  federationRoutes as routes,
} from "./routes";
import type { PeerEnv } from "./verify";

export interface FederationDeps {
  home: string;
}

export function consumePairInvite(db: Database, home: string): boolean {
  return consumeInviteFile(db, home);
}

export function pairWith(
  db: Database,
  home: string,
  target: { url: string; token: string },
  deps: PairDeps,
): Promise<PairAnswer> {
  return pair(db, home, target, deps);
}

export function federationRoutes(db: Database, deps: FederationRouteDeps): Hono<AuthEnv> {
  return routes(db, deps);
}

// Public (pairing by invite token, everything else signed); the caller mounts it before the
// session routes.
export function peerRoutes(db: Database, home: string): Hono<PeerEnv> {
  return publicPeer(db, home);
}

export function startFederation(_db: Database, _deps: FederationDeps): () => Promise<void> {
  return async () => {};
}
