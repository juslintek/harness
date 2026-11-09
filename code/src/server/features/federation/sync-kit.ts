import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstance, migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createApp } from "../../http";
import { listenDeferred, sessionHeaders } from "../../test-support/app-kit";
import { ensureProjectChannel } from "../chat/api";
import { createOrg, createProject, memberForUser } from "../orgs/api";
import { getPeer, type PeerRow } from "./peers-repo";
import { type PullStats, pullPeer } from "./pull";
import { TABLES } from "./schema";

export interface Node {
  db: Database;
  home: string;
  origin: string;
  instanceId: string;
  admin: { headers: Record<string, string>; userId: string };
  stop: () => void;
}

export async function bootNode(): Promise<Node> {
  const home = mkdtempSync(join(tmpdir(), "harness-sync-"));
  const db = openDb(join(home, "harness.db"));
  migrate(db, migrations);
  const instanceId = ensureInstance(db);
  const listener = listenDeferred();
  const origin = `http://localhost:${listener.port}`;
  const rp = { id: "localhost", name: "Harness", origin };
  listener.attach(createApp({ db, home, port: listener.port, rp, instanceId, version: "t" }));
  const admin = await sessionHeaders(db, { admin: true, stepUp: true, origin });
  return { db, home, origin, instanceId, admin, stop: () => void listener.server.stop(true) };
}

export async function api(
  node: Node,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = node.admin.headers,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${node.origin}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

// `from` invites, `to` redeems it.
export async function pairNodes(from: Node, to: Node): Promise<void> {
  const invite = await api(from, "POST", "/api/federation/invites");
  const pair = await api(to, "POST", "/api/federation/peers/pair", {
    url: from.origin,
    token: invite.json.token,
  });
  if (pair.status !== 200) throw new Error(`pairing failed: ${pair.status}`);
}

export function peerOn(node: Node, other: Node): PeerRow {
  const peer = getPeer(node.db, other.instanceId);
  if (!peer) throw new Error("not paired");
  return peer;
}

export const pull = (node: Node, from: Node): Promise<PullStats> =>
  pullPeer(node.db, node.home, peerOn(node, from));

export interface Seed {
  orgId: string;
  memberId: string;
  projectId: string;
}

export function seedProject(node: Node, slug = "acme"): Seed {
  const org = createOrg(node.db, {
    name: "Acme",
    slug,
    ownerUserId: node.admin.userId,
    ownerName: "Ann",
    ownerHandle: "ann",
  });
  const member = memberForUser(node.db, org.id, node.admin.userId);
  if (!member) throw new Error("owner missing");
  const project = createProject(node.db, { orgId: org.id, key: "ENG", name: "Eng" });
  ensureProjectChannel(node.db, project.id);
  return { orgId: org.id, memberId: member.id, projectId: project.id };
}

export const shareTo = (
  from: Node,
  seed: Seed,
  to: Node,
  permission: "read" | "write",
): ReturnType<typeof api> =>
  api(from, "POST", "/api/federation/shares", {
    projectId: seed.projectId,
    peerId: to.instanceId,
    permission,
  });

// The replicated columns of a table, in primary key order, for comparing two instances.
export function rowsOf(db: Database, table: string): Record<string, unknown>[] {
  const spec = TABLES.find((t) => t.name === table);
  if (!spec) throw new Error(`no such table: ${table}`);
  const order = spec.pk.join(", ");
  return db
    .query<Record<string, unknown>, []>(
      `SELECT ${spec.columns.join(", ")} FROM ${table} ORDER BY ${order}`,
    )
    .all();
}

export const countChanges = (db: Database): number =>
  db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM fed_changes").get()?.n ?? 0;

// The member the adoption step made for `userId` in the stub org that stands for this instance.
export function stubMemberOf(node: Node, userId: string): string {
  const row = node.db
    .query<{ id: string }, [string, string]>(
      `SELECT m.id FROM members m JOIN orgs o ON o.id = m.org_id
       WHERE o.home_instance = ? AND m.user_id = ?`,
    )
    .get(node.instanceId, userId);
  if (!row) throw new Error("no stub member");
  return row.id;
}
