import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { TaskView } from "../../../shared/board";
import {
  BoardError,
  getTask,
  type MoveResult,
  type RemoteTasks,
  setRemoteTasks,
} from "../board/api";
import { MemoryError, type RemoteNoteWriter, setRemoteNoteWriter } from "../memory/api";
import { signedFetch } from "./client";
import { sweepLeases, writeLease } from "./lease";
import { getPeer } from "./peers-repo";
import { pullPeer } from "./pull";

export const LEASE_TTL_MS: number = 5 * 60_000;
const CALL_TIMEOUT_MS = 5_000;
const DEFAULT_TICK_MS = 5_000;

type Failure = Exclude<MoveResult, { ok: true }>;

const failure: z.ZodType<Failure> = z.discriminatedUnion("reason", [
  z.object({ ok: z.literal(false), reason: z.literal("held"), holderId: z.string() }),
  z.object({ ok: z.literal(false), reason: z.literal("deps_open"), open: z.array(z.number()) }),
  z.object({ ok: z.literal(false), reason: z.literal("children_open"), open: z.array(z.number()) }),
  z.object({ ok: z.literal(false), reason: z.literal("not_found") }),
]);
const granted = z.object({ expiresAt: z.number() });

// The data directory of each running instance. An instance that never started federation has no
// entry, which keeps every board and memory call on its local path.
const homes = new WeakMap<Database, string>();

interface Remote {
  home: string;
  peerId: string;
}

function remoteOf(db: Database, projectId: string | null): Remote | null {
  const home = homes.get(db);
  const row =
    home === undefined || projectId === null
      ? undefined
      : db
          .query<{ home_instance: string | null }, [string]>(
            "SELECT home_instance FROM projects WHERE id = ?",
          )
          .get(projectId);
  return home !== undefined && row?.home_instance ? { home, peerId: row.home_instance } : null;
}

function remoteOfTask(db: Database, taskId: string): Remote | null {
  return remoteOf(db, getTask(db, taskId)?.projectId ?? null);
}

// Null covers an unreachable home, a timeout and a revoked or unknown peer: the caller refuses and
// changes nothing locally, so there is never a second claim to reconcile.
async function call(
  db: Database,
  remote: Remote,
  path: string,
  json: unknown,
): Promise<Response | null> {
  const peer = getPeer(db, remote.peerId);
  if (!peer || peer.revokedAt !== null) return null;
  try {
    return await signedFetch(db, remote.home, peer, path, { json, timeoutMs: CALL_TIMEOUT_MS });
  } catch {
    return null;
  }
}

// The home's answer reaches this copy through replication, so one pull right away lets the caller
// see the new holder; if it fails the next loop round delivers it.
async function pullNow(db: Database, remote: Remote): Promise<void> {
  const peer = getPeer(db, remote.peerId);
  if (peer) await pullPeer(db, remote.home, peer).catch(() => undefined);
}

async function expiryOf(res: Response): Promise<number> {
  const body = granted.safeParse(await res.json().catch(() => null));
  if (!body.success) throw new BoardError("home instance sent an unreadable answer");
  return body.data.expiresAt;
}

async function failureOf(res: Response): Promise<Failure> {
  const body = failure.safeParse(await res.json().catch(() => null));
  if (res.status === 403 || !body.success) {
    throw new BoardError("home instance refused the request");
  }
  return body.data;
}

const unavailable = (what: string): BoardError =>
  new BoardError(`home instance is unavailable, ${what}`);

// The call and its refusals are the same for a claim and a release; `landed` is what each does
// with a granted answer.
async function remoteMove(
  db: Database,
  taskId: string,
  path: string,
  body: Record<string, unknown>,
  landed: (remote: Remote, res: Response) => Promise<void>,
): Promise<MoveResult | null> {
  const remote = remoteOfTask(db, taskId);
  if (remote === null) return null;
  const res = await call(db, remote, path, { taskId, ...body });
  if (res === null) throw unavailable("nothing was changed");
  if (!res.ok) return failureOf(res);
  await landed(remote, res);
  await pullNow(db, remote);
  return { ok: true, task: getTask(db, taskId) as TaskView };
}

const remoteCheckout: RemoteTasks["checkout"] = (db, taskId, memberId) =>
  remoteMove(db, taskId, "/federation/lease", { memberId, ttlMs: LEASE_TTL_MS }, async (r, res) =>
    writeLease(db, taskId, r.peerId, memberId, await expiryOf(res)),
  );

const remoteRelease: RemoteTasks["release"] = (db, taskId, memberId) =>
  remoteMove(db, taskId, "/federation/lease/release", { memberId }, async () => {
    db.run("DELETE FROM fed_leases WHERE task_id = ?", [taskId]);
  });

const writeRemoteNote: RemoteNoteWriter = async (db, edit) => {
  const remote = remoteOf(db, edit.projectId);
  if (remote === null) return false;
  const res = await call(db, remote, "/federation/note", {
    noteId: edit.noteId,
    memberId: edit.memberId,
    baseHash: edit.baseHash,
    text: edit.text,
    meta: edit.meta,
  });
  if (res === null)
    throw new MemoryError("invalid", "home instance is unavailable, note not saved");
  if (res.status === 409) throw new MemoryError("conflict", "note changed since it was read");
  if (!res.ok) throw new MemoryError("forbidden", "home instance refused the write");
  await pullNow(db, remote);
  return true;
};

interface HeldLease {
  task_id: string;
  holder_instance: string;
  holder_member: string;
}

// A lease this instance holds at a home is renewed once half its life is gone. A refusal means the
// home no longer counts it as ours (expired or taken back), so the row goes; silence keeps it and
// the next round tries again.
export async function renewLeases(db: Database, now: number = Date.now()): Promise<void> {
  const due = db
    .query<HeldLease, [number]>(
      `SELECT l.task_id, l.holder_instance, l.holder_member FROM fed_leases l
       JOIN tasks t ON t.id = l.task_id JOIN projects p ON p.id = t.project_id
       WHERE p.home_instance IS NOT NULL AND l.expires_at - ? <= ${LEASE_TTL_MS / 2}`,
    )
    .all(now);
  const home = homes.get(db);
  if (home === undefined) return;
  for (const row of due) {
    const remote = { home, peerId: row.holder_instance };
    const res = await call(db, remote, "/federation/lease", {
      taskId: row.task_id,
      memberId: row.holder_member,
      ttlMs: LEASE_TTL_MS,
      renew: true,
    });
    if (res === null) continue;
    if (!res.ok) db.run("DELETE FROM fed_leases WHERE task_id = ?", [row.task_id]);
    else writeLease(db, row.task_id, row.holder_instance, row.holder_member, await expiryOf(res));
  }
}

// Registers this instance with board and memory and runs the lease upkeep loop: the home gives
// expired leases back, a copy renews the ones it holds. Drained on stop.
export function startLeases(
  db: Database,
  home: string,
  opts: { intervalMs?: number } = {},
): () => Promise<void> {
  homes.set(db, home);
  setRemoteTasks({ checkout: remoteCheckout, release: remoteRelease });
  setRemoteNoteWriter(writeRemoteNote);
  const interval = opts.intervalMs ?? DEFAULT_TICK_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const tick = (): void => {
    running = (async () => {
      sweepLeases(db);
      await renewLeases(db);
    })()
      .catch((e: Error) => console.warn(`federation: lease upkeep failed: ${e.message}`))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, interval);
      });
  };
  timer = setTimeout(tick, interval);
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
    homes.delete(db);
  };
}
