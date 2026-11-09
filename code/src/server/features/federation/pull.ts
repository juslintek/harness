import type { Database } from "bun:sqlite";
import { ensureInstance } from "../../db/db";
import { DomainError } from "../../route-kit";
import { adoptRemoteOrgs } from "../orgs/api";
import { applyBatch, type Change } from "./apply";
import { flushPending, noteBodies } from "./bodies";
import { loadHlcState, saveHlcState } from "./capture";
import { signedFetch } from "./client";
import { type FeedChange, type FeedPage, feedPage, PAGE_LIMIT } from "./feed";
import { hlcReceive } from "./hlc";
import { permitInbound } from "./inbound";
import { listPeers, type PeerRow } from "./peers-repo";
import type { NoteBodies } from "./schema";

const DEFAULT_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

export interface PullDeps {
  bodies?: NoteBodies;
  now?: () => number;
}

export interface PullStats {
  applied: number;
  stale: number;
  // Refused by the permission filter, the clock check or the apply rules; the count is all we keep.
  rejected: number;
}

const cursorKey = (peerId: string): string => `cursor:${peerId}`;

function getCursor(db: Database, peerId: string): number {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM fed_state WHERE key = ?")
    .get(cursorKey(peerId));
  return row ? Number(row.value) : 0;
}

function toChange(c: FeedChange): Change {
  return {
    project_id: c.projectId,
    table_name: c.table,
    row_id: c.rowId,
    op: c.op,
    hlc: c.hlc,
    origin_instance: c.origin,
    data: c.data === null ? null : JSON.stringify(c.data),
  };
}

// The cursor moves in the same transaction as the rows, so a failed apply leaves it where it was
// and the page is fetched again. Local edits are flushed first: their hlc must exist before a
// remote row can compete with them, otherwise the remote value would overwrite a newer local one.
function applyPage(
  db: Database,
  home: string,
  peerId: string,
  page: FeedPage,
  deps: PullDeps,
): PullStats {
  return db.transaction(() => {
    const now = (deps.now ?? Date.now)();
    flushPending(db, home, now);
    const instanceId = ensureInstance(db);
    const clock = loadHlcState(db, instanceId);
    let skewed = 0;
    const heard = page.changes.map(toChange).filter((change) => {
      try {
        hlcReceive(clock, change.hlc, now);
        return true;
      } catch {
        skewed += 1;
        return false;
      }
    });
    const { allowed, dropped } = permitInbound(db, peerId, heard);
    const result = applyBatch(db, allowed, deps.bodies ?? noteBodies(db, home));
    saveHlcState(db, clock);
    adoptRemoteOrgs(db, instanceId);
    db.run("INSERT OR REPLACE INTO fed_state (key, value) VALUES (?, ?)", [
      cursorKey(peerId),
      String(page.next),
    ]);
    return {
      applied: result.applied,
      stale: result.stale,
      rejected: result.rejected + dropped + skewed,
    };
  })();
}

async function fetchPage(
  db: Database,
  home: string,
  peer: PeerRow,
  since: number,
): Promise<FeedPage> {
  const res = await signedFetch(
    db,
    home,
    peer,
    `/federation/changes?since=${since}&limit=${PAGE_LIMIT}`,
  );
  if (!res.ok) throw new DomainError(`peer answered ${res.status}`);
  const page = feedPage.safeParse(await res.json());
  if (!page.success) throw new DomainError("peer sent an unreadable page");
  return page.data;
}

// One full catch-up from one peer: pages until the feed runs dry.
export async function pullPeer(
  db: Database,
  home: string,
  peer: PeerRow,
  deps: PullDeps = {},
): Promise<PullStats> {
  const total: PullStats = { applied: 0, stale: 0, rejected: 0 };
  let cursor = getCursor(db, peer.id);
  for (;;) {
    const page = await fetchPage(db, home, peer, cursor);
    const stats = applyPage(db, home, peer.id, page, deps);
    total.applied += stats.applied;
    total.stale += stats.stale;
    total.rejected += stats.rejected;
    if (page.changes.length < PAGE_LIMIT || page.next <= cursor) break;
    cursor = page.next;
  }
  if (total.rejected > 0) {
    console.warn(`federation: dropped ${total.rejected} changes from peer ${peer.id}`);
  }
  return total;
}

// Returns how many peers failed, so the loop can back off. One bad peer does not stop the others.
async function pullAll(db: Database, home: string, deps: PullDeps = {}): Promise<number> {
  // Edits get their clock stamp when flushed, so flushing on every round keeps "last writer"
  // close to the time of the edit instead of the time a peer happened to ask.
  flushPending(db, home, (deps.now ?? Date.now)());
  let failures = 0;
  for (const peer of listPeers(db)) {
    if (peer.revokedAt !== null) continue;
    try {
      await pullPeer(db, home, peer, deps);
    } catch (e) {
      failures += 1;
      console.warn(`federation: pull from peer ${peer.id} failed: ${(e as Error).message}`);
    }
  }
  return failures;
}

export function startPull(
  db: Database,
  home: string,
  opts: { intervalMs?: number } = {},
): () => Promise<void> {
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;
  let failedRounds = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const round = (): void => {
    running = pullAll(db, home)
      .then((failed) => {
        failedRounds = failed > 0 ? failedRounds + 1 : 0;
      })
      .catch(() => {
        failedRounds += 1;
      })
      .finally(() => {
        if (stopped) return;
        timer = setTimeout(round, Math.min(MAX_BACKOFF_MS, interval * 2 ** failedRounds));
      });
  };
  timer = setTimeout(round, interval);
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}
