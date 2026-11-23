import type { Database } from "bun:sqlite";
import {
  type AccountKind,
  type AccountState,
  type AccountView,
  accountView,
} from "../../../shared/accounts";

interface AccountRow {
  id: string;
  runtime: string;
  kind: AccountKind;
  label: string;
  home: string | null;
  state: AccountState;
  identity_hint: string | null;
  max_concurrent: number;
  priority: number;
  exhausted_until: number | null;
  last_probe_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface NewAccount {
  // The caller picks it when the home path is derived from it.
  id?: string;
  runtime: string;
  kind: AccountKind;
  label: string;
  home: string | null;
}

export interface AccountPatch {
  label?: string;
  home?: string | null;
  state?: AccountState;
  identityHint?: string | null;
  maxConcurrent?: number;
  priority?: number;
  exhaustedUntil?: number | null;
  lastProbeAt?: number | null;
}

const COLUMN: Record<keyof AccountPatch, string> = {
  label: "label",
  home: "home",
  state: "state",
  identityHint: "identity_hint",
  maxConcurrent: "max_concurrent",
  priority: "priority",
  exhaustedUntil: "exhausted_until",
  lastProbeAt: "last_probe_at",
};

function toView(row: AccountRow): AccountView {
  return accountView.parse({
    id: row.id,
    runtime: row.runtime,
    kind: row.kind,
    label: row.label,
    home: row.home,
    state: row.state,
    identityHint: row.identity_hint,
    maxConcurrent: row.max_concurrent,
    priority: row.priority,
    exhaustedUntil: row.exhausted_until,
    lastProbeAt: row.last_probe_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function listAccounts(db: Database, runtime?: string): AccountView[] {
  const rows = runtime
    ? db
        .query<AccountRow, [string]>(
          "SELECT * FROM agent_accounts WHERE runtime = ? ORDER BY priority DESC, created_at, id",
        )
        .all(runtime)
    : db
        .query<AccountRow, []>(
          "SELECT * FROM agent_accounts ORDER BY runtime, priority DESC, created_at, id",
        )
        .all();
  return rows.map(toView);
}

export function getAccount(db: Database, id: string): AccountView | null {
  const row = db.query<AccountRow, [string]>("SELECT * FROM agent_accounts WHERE id = ?").get(id);
  return row ? toView(row) : null;
}

// Codex rotates refresh tokens on use, so concurrent runs on one account can race.
function defaultConcurrency(runtime: string): number {
  return runtime === "codex" ? 1 : 2;
}

export function createAccount(db: Database, input: NewAccount): AccountView {
  const id = input.id ?? Bun.randomUUIDv7();
  const now = Date.now();
  db.run(
    `INSERT INTO agent_accounts
       (id, runtime, kind, label, home, state, max_concurrent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [
      id,
      input.runtime,
      input.kind,
      input.label,
      input.home,
      defaultConcurrency(input.runtime),
      now,
      now,
    ],
  );
  const created = getAccount(db, id);
  if (!created) throw new Error("account vanished after insert");
  return created;
}

export function updateAccount(db: Database, id: string, patch: AccountPatch): AccountView | null {
  const keys = (Object.keys(patch) as Array<keyof AccountPatch>).filter(
    (key) => patch[key] !== undefined,
  );
  const sets = keys.map((key) => `${COLUMN[key]} = ?`);
  const values = keys.map((key) => patch[key] ?? null);
  db.run(`UPDATE agent_accounts SET ${[...sets, "updated_at = ?"].join(", ")} WHERE id = ?`, [
    ...values,
    Date.now(),
    id,
  ]);
  return getAccount(db, id);
}

// The row stays: runs, quota rows and events keep pointing at its id.
export function markRemoved(db: Database, id: string): AccountView | null {
  return updateAccount(db, id, { state: "removed" });
}

export function ensureDefaultAccount(db: Database, runtime: string): AccountView {
  const now = Date.now();
  db.run(
    `INSERT OR IGNORE INTO agent_accounts
       (id, runtime, kind, label, home, state, max_concurrent, created_at, updated_at)
     VALUES (?, ?, 'login', 'default', NULL, 'unknown', ?, ?, ?)`,
    [`default:${runtime}`, runtime, defaultConcurrency(runtime), now, now],
  );
  const account = getAccount(db, `default:${runtime}`);
  if (!account) throw new Error("default account missing after insert");
  return account;
}

// Only ever pushes the block later: a short "overloaded" skip must not cut a quota block short.
export function markExhausted(db: Database, id: string, until: number): void {
  if (id.startsWith("default:")) ensureDefaultAccount(db, id.slice("default:".length));
  const { changes } = db.run(
    "UPDATE agent_accounts SET exhausted_until = max(COALESCE(exhausted_until, 0), ?), updated_at = ? WHERE id = ?",
    [until, Date.now(), id],
  );
  // Removed accounts keep their row, so a missing one means a bad id and the block would be lost.
  if (changes === 0) console.warn(`exhaustion not recorded, unknown account: ${id}`);
}

const BACKOFF_BASE_MS = 15 * 60_000;
const BACKOFF_CAP_MS = 5 * 60 * 60_000;

// Unprobed accounts back off 15, 30, 60, ... minutes up to the window length across consecutive rate limits.
export function recordReactiveExhaustion(
  db: Database,
  id: string,
  now: number = Date.now(),
  capMs: number = BACKOFF_CAP_MS,
): number {
  if (id.startsWith("default:")) ensureDefaultAccount(db, id.slice("default:".length));
  const row = db
    .query<{ exhaustion_streak: number }, [string]>(
      "SELECT exhaustion_streak FROM agent_accounts WHERE id = ?",
    )
    .get(id);
  const streak = row?.exhaustion_streak ?? 0;
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** streak, capMs);
  const until = now + delay;
  const { changes } = db.run(
    `UPDATE agent_accounts
       SET exhausted_until = max(COALESCE(exhausted_until, 0), ?),
           exhaustion_streak = ?,
           updated_at = ?
     WHERE id = ?`,
    [until, streak + 1, now, id],
  );
  if (changes === 0) console.warn(`exhaustion not recorded, unknown account: ${id}`);
  return until;
}

export function resetExhaustionStreak(db: Database, id: string): void {
  db.run("UPDATE agent_accounts SET exhaustion_streak = 0, updated_at = ? WHERE id = ?", [
    Date.now(),
    id,
  ]);
}
