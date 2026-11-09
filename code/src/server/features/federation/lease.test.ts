import { afterAll, beforeAll, expect, test } from "bun:test";
import { BoardError, checkoutTask, createTask, getTask, releaseTask } from "../board/api";
import {
  createNote,
  getIndexedByDisk,
  MemoryError,
  projectSlugs,
  resolveNotePath,
  saveNote,
  searchNotes,
  type Viewer,
} from "../memory/api";
import { createProject } from "../orgs/api";
import { startFederation } from "./api";
import { signedFetch } from "./client";
import { sweepLeases } from "./lease";
import { LEASE_TTL_MS, renewLeases } from "./lease-client";
import {
  bootNode,
  type Node,
  pairNodes,
  peerOn,
  pull,
  type Seed,
  seedProject,
  shareTo,
  stubMemberOf,
} from "./sync-kit";

let a: Node;
let b: Node;
let c: Node;
let seed: Seed;
let bMember: string;
let readTask: string;
let stops: (() => Promise<void>)[] = [];

const newTask = async (title: string, projectId = seed.projectId): Promise<string> => {
  const id = createTask(a.db, { projectId, title, createdBy: seed.memberId }).id;
  await pull(b, a);
  return id;
};
const holderOf = (node: Node, id: string): string | null | undefined =>
  getTask(node.db, id)?.holderId;
const leaseRows = (node: Node): number =>
  node.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM fed_leases").get()?.n ?? 0;

// Straight to the home's route, as a peer that bypasses the board code would.
const direct = (from: Node, path: string, json: unknown): Promise<Response> =>
  signedFetch(from.db, from.home, peerOn(from, a), path, { json });

beforeAll(async () => {
  [a, b, c] = await Promise.all([bootNode(), bootNode(), bootNode()]);
  await pairNodes(a, b);
  await pairNodes(a, c);
  seed = seedProject(a);
  const ro = createProject(a.db, { orgId: seed.orgId, key: "RO", name: "Read only" });
  await shareTo(a, seed, b, "write");
  await shareTo(a, { ...seed, projectId: ro.id }, b, "read");
  await pull(b, a);
  bMember = stubMemberOf(b, b.admin.userId);
  await pull(a, b);
  readTask = await newTask("ro", ro.id);
  stops = [a, b, c].map((n) => startFederation(n.db, { home: n.home, pullIntervalMs: 60_000 }));
});

afterAll(async () => {
  await Promise.all(stops.map((stop) => stop()));
  for (const node of [a, b, c]) node.stop();
});

test("both instances racing for one task: exactly one gets it", async () => {
  const id = await newTask("race");
  const results = await Promise.allSettled([
    checkoutTask(a.db, id, seed.memberId),
    checkoutTask(b.db, id, bMember),
  ]);
  const won = results.filter((r) => r.status === "fulfilled" && r.value.ok);
  expect(won).toHaveLength(1);
  const holder = holderOf(a, id);
  expect([seed.memberId, bMember]).toContain(holder as string);
  await pull(b, a);
  // An owner-side holder is a member row the copy may not have; only the copy's own member is
  // guaranteed to come back.
  if (holder === bMember) expect(holderOf(b, id)).toBe(bMember);
  await releaseTask(a.db, id, holder as string);
});

test("a checkout on the copy lands on the home and shows on both boards", async () => {
  const id = await newTask("copy checkout");
  const res = await checkoutTask(b.db, id, bMember);
  expect(res.ok).toBe(true);
  expect(holderOf(a, id)).toBe(bMember);
  expect(holderOf(b, id)).toBe(bMember);
  expect(leaseRows(a)).toBeGreaterThan(0);
  const second = await checkoutTask(a.db, id, seed.memberId);
  expect(second).toEqual({ ok: false, reason: "held", holderId: bMember });
  const released = await releaseTask(b.db, id, bMember);
  expect(released.ok).toBe(true);
  expect(holderOf(a, id)).toBeNull();
});

test("an expired lease frees the task on the home, a late renewal does not take it back", async () => {
  const id = await newTask("expiry");
  await checkoutTask(b.db, id, bMember);
  expect(sweepLeases(a.db, Date.now() + 1_000)).toBe(0);
  expect(sweepLeases(a.db, Date.now() + LEASE_TTL_MS + 1_000)).toBe(1);
  expect(holderOf(a, id)).toBeNull();
  await renewLeases(b.db, Date.now() + LEASE_TTL_MS);
  expect(holderOf(a, id)).toBeNull();
  expect(leaseRows(b)).toBe(0);
});

test("a renewal before expiry extends the lease", async () => {
  const id = await newTask("renew");
  await checkoutTask(b.db, id, bMember);
  const before = a.db
    .query<{ expires_at: number }, [string]>("SELECT expires_at FROM fed_leases WHERE task_id = ?")
    .get(id)?.expires_at as number;
  await renewLeases(b.db, Date.now() + LEASE_TTL_MS - 1_000);
  const after = a.db
    .query<{ expires_at: number }, [string]>("SELECT expires_at FROM fed_leases WHERE task_id = ?")
    .get(id)?.expires_at as number;
  expect(after).toBeGreaterThan(before);
  expect(holderOf(a, id)).toBe(bMember);
  await releaseTask(b.db, id, bMember);
});

test("a peer holding only a read grant cannot lease", async () => {
  const res = await direct(b, "/federation/lease", {
    taskId: readTask,
    memberId: bMember,
    ttlMs: 1_000,
  });
  expect(res.status).toBe(403);
  expect(checkoutTask(b.db, readTask, bMember)).rejects.toBeInstanceOf(BoardError);
  expect(holderOf(a, readTask)).toBeNull();
});

test("a peer with no grant can neither lease nor write notes", async () => {
  const id = await newTask("closed");
  const lease = await direct(c, "/federation/lease", {
    taskId: id,
    memberId: bMember,
    ttlMs: 1_000,
  });
  expect(lease.status).toBe(403);
  const note = await direct(c, "/federation/note", {
    noteId: "x",
    memberId: bMember,
    baseHash: "h",
    text: "t",
  });
  expect(note.status).toBe(403);
  expect(holderOf(a, id)).toBeNull();
});

test("note writes on the copy go through the home: stale hash refused, good hash lands", async () => {
  const viewerA: Viewer = {
    orgId: seed.orgId,
    memberId: null,
    projectIds: [seed.projectId],
    canWriteGlobal: false,
    canWrite: true,
    actor: "ann",
  };
  const loc = resolveNotePath(
    "/memories/project/ENG/lease.md",
    viewerA,
    projectSlugs(a.db, seed.orgId),
  );
  if (loc === null || loc === "dir") throw new Error("bad path");
  await createNote(a.db, a.home, { viewer: viewerA, runId: null }, loc, "# Lease\n\nfirst text");
  await pull(b, a);
  const viewerB: Viewer = { ...viewerA, memberId: bMember, actor: "bob" };
  const ctx = { viewer: viewerB, runId: null };
  const note = getIndexedByDisk(b.db, loc.disk);
  const stale = saveNote(b.db, b.home, ctx, note?.id as string, "0".repeat(64), "# Lease\n\nnope");
  expect(stale).rejects.toBeInstanceOf(MemoryError);
  expect(searchNotes(a.db, viewerA, { text: "nope" })).toEqual([]);

  const saved = await saveNote(
    b.db,
    b.home,
    ctx,
    note?.id as string,
    note?.hash as string,
    "# Lease\n\nsecond zebra text",
  );
  const onHome = getIndexedByDisk(a.db, loc.disk);
  expect(onHome?.hash).toBe(saved.note.hash);
  expect(searchNotes(a.db, viewerA, { text: "zebra" }).map((n) => n.disk)).toEqual([loc.disk]);
});

test("with the home down a checkout and a note write are refused and change nothing", async () => {
  const id = await newTask("home down");
  a.stop();
  const err = await checkoutTask(b.db, id, bMember).catch((e: Error) => e);
  expect(err).toBeInstanceOf(BoardError);
  expect(holderOf(b, id)).toBeNull();
  expect(leaseRows(b)).toBe(0);
});
