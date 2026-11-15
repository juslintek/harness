import type { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AccountView } from "../../../shared/accounts";
import { appendEvent, type EventKind } from "../logs/api";
import * as repo from "./accounts-repo";
import { getSpec } from "./api";
import { logoutAccount, type Runner } from "./discover";
import { stopLogin } from "./login-registry";
import type { AgentSpec } from "./specs";

export class AccountError extends Error {
  readonly status: 404 | 409;
  constructor(status: 404 | 409, message: string) {
    super(message);
    this.name = "AccountError";
    this.status = status;
  }
}

const LIVE_RUN_STATES = ["running", "starting", "queued"];

const accountsDir = (home: string): string => join(home, "accounts");

// Only the id and the label go in: a label is limited to a safe set, and no path or token is logged.
export function auditAccount(
  db: Database,
  kind: Extract<EventKind, `account.${string}`>,
  account: AccountView,
  detail?: string,
): void {
  appendEvent(db, {
    kind,
    agent: account.runtime,
    accountId: account.id,
    source: "accounts",
    body: `${account.id} ${account.label}${detail ? ` ${detail}` : ""}`,
  });
}

export function accountOf(db: Database, runtime: string, id: string): AccountView {
  const account = repo.getAccount(db, id);
  if (!account || account.runtime !== runtime) throw new AccountError(404, "unknown account");
  return account;
}

export function assertIsolated(spec: AgentSpec | null): void {
  if (!spec?.accountIsolation)
    throw new AccountError(409, "this runtime is not enabled for extra accounts yet");
}

export function addAccount(
  db: Database,
  home: string,
  runtime: string,
  label: string,
  spec: AgentSpec | null = getSpec(runtime),
): AccountView {
  assertIsolated(spec);
  // The default account owns this label; a custom one would block ensureDefaultAccount on link.
  if (label.toLowerCase() === "default")
    throw new AccountError(409, "the label default is reserved for the runtime's own login");
  const taken = new AccountError(409, `an account named ${label} already exists for ${runtime}`);
  if (repo.listAccounts(db, runtime).some((account) => account.label === label)) throw taken;
  const id = Bun.randomUUIDv7();
  const dir = join(accountsDir(home), id);
  mkdirSync(accountsDir(home), { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 });
  // mkdir applies the umask, and an account home holds a login.
  chmodSync(dir, 0o700);
  let account: AccountView;
  try {
    account = repo.createAccount(db, { id, runtime, kind: "login", label, home: dir });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") throw taken;
    throw err;
  }
  auditAccount(db, "account.added", account);
  return account;
}

export function setAccountEnabled(
  db: Database,
  runtime: string,
  id: string,
  enabled: boolean,
): AccountView {
  const account = accountOf(db, runtime, id);
  if (account.state === "removed" || account.state === "removing")
    throw new AccountError(409, `the account is ${account.state}`);
  // Enabling an account that was never disabled changes nothing, so an active one stays active.
  if (enabled !== (account.state === "disabled")) return account;
  const next = repo.updateAccount(db, id, { state: enabled ? "unknown" : "disabled" });
  if (!next) throw new AccountError(404, "unknown account");
  auditAccount(db, enabled ? "account.enabled" : "account.disabled", next);
  return next;
}

function liveRuns(db: Database, id: string): number {
  const marks = LIVE_RUN_STATES.map(() => "?").join(", ");
  const row = db
    .query<{ n: number }, string[]>(
      `SELECT count(*) AS n FROM runs WHERE account_id = ? AND state IN (${marks})`,
    )
    .get(id, ...LIVE_RUN_STATES);
  return row?.n ?? 0;
}

// The stored path is only trusted after it resolves, symlinks included, to <accounts>/<id>.
// Returns null when the directory is already gone.
function ownedHome(home: string, account: AccountView): string | null {
  if (!account.home) throw new AccountError(409, "the account has no home of its own");
  let resolved: string;
  try {
    resolved = realpathSync(account.home);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let root: string;
  try {
    root = realpathSync(accountsDir(home));
  } catch (err) {
    // The home exists but the directory that should hold it does not, so it cannot be ours.
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      throw new AccountError(409, "the accounts directory is missing, not deleting the home");
    throw err;
  }
  if (dirname(resolved) !== root || resolved !== join(root, account.id))
    throw new AccountError(409, "the account home is outside the accounts directory, not deleting");
  return resolved;
}

// Removals in flight in this process. A drained or failed account is already `removing` in the
// database, so the row alone cannot tell a retry from a second request running right now.
const inFlight = new Set<string>();

async function finishRemoval(
  db: Database,
  home: string,
  account: AccountView,
  how: { spec?: AgentSpec | null; run?: Runner },
): Promise<{ removed: AccountView; logout: string }> {
  await stopLogin(account.id);
  const spec = how.spec === undefined ? getSpec(account.runtime) : how.spec;
  const logout = spec ? await logoutAccount(spec, account, how.run) : "no logout command";
  // Checked again here, right before the delete: the awaits above can take seconds, and the row
  // is the only thing that names the path.
  const dir = ownedHome(home, account);
  if (dir) rmSync(dir, { recursive: true, force: true });
  // The row stays, but its label is freed: UNIQUE (runtime, label) would otherwise block it forever.
  const removed = repo.updateAccount(db, account.id, {
    state: "removed",
    label: `${account.label}~removed~${account.id}`,
  });
  if (!removed) throw new AccountError(404, "unknown account");
  return { removed, logout };
}

function assertRemovable(account: AccountView, runtime: string): void {
  if (account.id === `default:${runtime}` || account.home === null)
    throw new AccountError(
      409,
      "the default account cannot be removed, unlink the runtime instead",
    );
  if (account.state === "removed") throw new AccountError(409, "the account is already removed");
  if (inFlight.has(account.id)) throw new AccountError(409, "the account is already being removed");
}

// One row changing is the claim: a second remove for the same account loses it. A drained or
// failed account is already `removing` and keeps going.
function claimRemoval(db: Database, account: AccountView): void {
  if (account.state === "removing") return;
  const claimed = db.run(
    "UPDATE agent_accounts SET state = 'removing', updated_at = ? WHERE id = ? AND state NOT IN ('removing', 'removed')",
    [Date.now(), account.id],
  );
  if (claimed.changes !== 1) throw new AccountError(409, "the account is already being removed");
}

export async function removeAccount(
  db: Database,
  home: string,
  runtime: string,
  id: string,
  drain: boolean,
  how: { spec?: AgentSpec | null; run?: Runner } = {},
): Promise<AccountView> {
  const account = accountOf(db, runtime, id);
  assertRemovable(account, runtime);
  // A second drain changes nothing, so it neither rewrites the row nor repeats the audit event.
  if (account.state === "removing" && drain) return account;
  const live = liveRuns(db, id) > 0;
  if (live && !drain) throw new AccountError(409, "the account has live runs, retry with ?drain=1");
  // Before anything runs with this home: a vendor logout must never see a path outside ours.
  ownedHome(home, account);
  claimRemoval(db, account);
  const claimedView = accountOf(db, runtime, id);
  if (live) {
    auditAccount(db, "account.removed", claimedView, "draining");
    return claimedView;
  }
  inFlight.add(id);
  try {
    const { removed, logout } = await finishRemoval(db, home, account, how);
    // The audit line keeps the name the holder knew, not the tombstone label.
    auditAccount(db, "account.removed", { ...removed, label: account.label }, logout);
    return removed;
  } catch (err) {
    const reason =
      err instanceof AccountError ? err.message : ((err as { code?: string }).code ?? "error");
    auditAccount(db, "account.remove_failed", claimedView, reason);
    throw new AccountError(409, `removal failed (${reason}), the account stays in removing`);
  } finally {
    inFlight.delete(id);
  }
}
