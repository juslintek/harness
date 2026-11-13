import type { Database } from "bun:sqlite";
import { spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstance, migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createApp } from "../../http";
import { listenDeferred, sessionHeaders } from "../../test-support/app-kit";
import { ensureProjectChannel } from "../chat/api";
import { createOrg, createProject, memberForUser } from "../orgs/api";
import { applyBatch, type BatchResult, type Change } from "./apply";
import type { FeedChange } from "./feed";
import { permitInbound } from "./inbound";
import { keyOf } from "./inbound-refs";
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

// A change as the peer would send it, for judging with permitInbound.

export function peerChange(
  peer: Node,
  table: string,
  rowId: string,
  project: string,
  data: object,
  origin: string = peer.instanceId,
): Change {
  return {
    project_id: project,
    table_name: table,
    row_id: rowId,
    op: "put",
    hlc: `${String(Date.now()).padStart(13, "0")}-0000-${peer.instanceId}`,
    origin_instance: origin,
    data: JSON.stringify(data),
  };
}

export const taskRow = (id: string, project: string, org: string): object => ({
  id,
  org_id: org,
  project_id: project,
  number: 9,
  parent_id: null,
  title: "forged",
  description: "",
  status: "todo",
  rank: 1,
  assignee_id: null,
  holder_id: null,
  checked_out_at: null,
  estimate_minutes: null,
  created_by: "x",
  created_at: 1,
  updated_at: 1,
});

// A human member of the stub org that stands for `peer` on `host`, as the peer's own users appear there.
export function addPeerMember(host: Node, peer: Node, id: string): void {
  const stub = host.db
    .query<{ id: string }, [string]>("SELECT id FROM orgs WHERE home_instance = ?")
    .get(peer.instanceId)?.id;
  host.db.run(
    `INSERT INTO members (id, org_id, kind, user_id, handle, display_name, role, created_at)
     VALUES (?, ?, 'human', ?, ?, ?, 'member', 1)`,
    [id, stub ?? null, `remote:${id}`, id, id],
  );
}

export const ids = (changes: readonly Change[]): string[] => changes.map(keyOf);

export const applied = (n: number): BatchResult => ({ applied: n, stale: 0, rejected: 0 });

export const permutations = <T>(xs: T[]): T[][] =>
  xs.length < 2
    ? [xs]
    : xs.flatMap((x, i) =>
        permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
      );

export interface PlantedKit {
  put: (table: string, id: string, project: string, data: object) => Change;
  run: (...changes: Change[]) => { allowed: string[]; result: BatchResult };
  stored: (table: string, id: string) => number;
}

// Helpers for a page that `peer` sends to `home`. The nodes are read when a helper is called, so a
// test file may build the kit at module load and let beforeAll boot the nodes later.
export function plantedKit(home: () => Node, peer: () => Node): PlantedKit {
  let tick = 0;
  return {
    // Newer than anything stored, and later than the put before it.
    put: (table, id, project, data) => ({
      ...peerChange(peer(), table, id, project, data),
      hlc: `${String(Date.now() + 10_000 + ++tick).padStart(13, "0")}-0000-${peer().instanceId}`,
    }),
    run: (...changes) => {
      const { allowed } = permitInbound(home().db, peer().instanceId, changes);
      return { allowed: ids(allowed), result: applyBatch(home().db, allowed) };
    },
    stored: (table, id) =>
      home()
        .db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`)
        .get(id)?.n ?? 0,
  };
}

// `a` pulls from `b`, which holds a write grant on a project of `a` and has a member of its own
// there: the position a peer has to be in for a hostile page to get past permitInbound.
export async function writePair(): Promise<{ a: Node; b: Node; seed: Seed }> {
  const [a, b] = await Promise.all([bootNode(), bootNode()]);
  await pairNodes(a, b);
  const seed = seedProject(a);
  await shareTo(a, seed, b, "write");
  addPeerMember(a, b, "m-bee");
  return { a, b, seed };
}

// A task the peer's own member created in the granted project, so only the rule under test refuses it.
export const beeTask = (peer: Node, id: string, seed: Seed): Change =>
  peerChange(peer, "tasks", id, seed.projectId, {
    ...taskRow(id, seed.projectId, seed.orgId),
    created_by: "m-bee",
  });

export const feedOf = (seq: number, c: Change): FeedChange => ({
  seq,
  projectId: c.project_id,
  table: c.table_name,
  rowId: c.row_id,
  op: c.op,
  hlc: c.hlc,
  origin: c.origin_instance,
  data: c.data === null ? null : JSON.parse(c.data),
});

export const cursorOf = (node: Node, peer: Node): string | undefined =>
  node.db
    .query<{ value: string }, [string]>("SELECT value FROM fed_state WHERE key = ?")
    .get(`cursor:${peer.instanceId}`)?.value;

// Answers the signed GET of a peer's changes feed with `answer`; every other request goes through.
export function answerFeed(answer: (url: URL) => Response): () => void {
  const real = globalThis.fetch;
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (...args: Parameters<typeof fetch>): Promise<Response> => {
        const url = new URL(String(args[0]));
        return url.pathname === "/federation/changes" ? answer(url) : real(...args);
      },
      { preconnect: real.preconnect },
    ),
  );
  return () => spy.mockRestore();
}
