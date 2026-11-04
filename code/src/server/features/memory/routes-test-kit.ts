import type { Database } from "bun:sqlite";
import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrgView } from "../../../shared/orgs";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createApp } from "../../http";
import { type SessionOpts, sessionHeaders } from "../../test-support/app-kit";
import { createOrg } from "../orgs/api";
import { drainCommits } from "./git-log";

const ORIGIN = "http://localhost:4100";
let home: string;

// Registers the per-test home dir and its cleanup; call once at the top of a test file.
export function useHome(): void {
  beforeEach(() => {
    // A closed port keeps note classification off a real Laya.
    process.env.OLLAYA_URL = "http://127.0.0.1:1";
    home = mkdtempSync(join(tmpdir(), "harness-routes-"));
  });
  afterEach(async () => {
    delete process.env.OLLAYA_URL;
    await drainCommits();
    rmSync(home, { recursive: true, force: true });
  });
}

type Who = { headers: Record<string, string>; userId: string };

export interface Kit {
  app: ReturnType<typeof createApp>;
  db: Database;
  home: string;
  call: (
    who: { headers: Record<string, string> },
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<Response>;
  alice: Who;
  bob: Who;
  carol: Who;
  acme: OrgView;
  beta: OrgView;
  user: (opts?: SessionOpts) => Promise<Who>;
}

export async function boot(): Promise<Kit> {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const app = createApp({
    db,
    home,
    port: 4100,
    rp: { id: "localhost", name: "Harness", origin: ORIGIN },
    instanceId: "i",
    version: "1",
  });
  const user = (opts: SessionOpts = {}) => sessionHeaders(db, { ...opts, origin: ORIGIN });
  const org = (slug: string, owner: { userId: string }) =>
    createOrg(db, {
      name: slug,
      slug,
      ownerUserId: owner.userId,
      ownerName: slug,
      ownerHandle: slug,
    });
  const call = (
    who: { headers: Record<string, string> },
    method: string,
    path: string,
    body?: unknown,
  ) =>
    Promise.resolve(
      app.request(path, {
        method,
        headers: who.headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const [alice, bob, carol] = [await user(), await user(), await user()] as const;
  const acme = org("acme", alice);
  const beta = org("beta", bob);
  return { app, db, home, call, alice, bob, carol, acme, beta, user };
}

export const BASE = "/api/orgs/acme/memory";
