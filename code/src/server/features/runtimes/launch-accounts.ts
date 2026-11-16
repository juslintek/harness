import type { Database } from "bun:sqlite";
import { type AgentSpec, accountEnv, getAccount } from "../agents/api";
import { codexRules } from "../guard/api";
import { prepareAccountCodexHome, prepareCodexHome } from "./codex-home";

// What a run needs of its account: the id for attribution, the home for the CLI. A NULL home is
// the CLI's own default login.
export interface RunAccount {
  id: string;
  home: string | null;
}

export class AccountUnavailable extends Error {
  constructor(reason: string) {
    super(`account unavailable: ${reason}`);
    this.name = "AccountUnavailable";
  }
}

const USABLE = new Set(["active", "unknown"]);

export function resolveRunAccount(db: Database, spec: AgentSpec, accountId: string): RunAccount {
  const account = getAccount(db, accountId);
  if (!account) throw new AccountUnavailable("unknown");
  if (account.runtime !== spec.id) throw new AccountUnavailable("belongs to another runtime");
  if (!USABLE.has(account.state)) throw new AccountUnavailable(account.state);
  // Without a CLI that keeps its login per directory, a home would be ignored and the run would
  // silently use the default login.
  if (account.home !== null && !spec.accountIsolation) {
    throw new AccountUnavailable("runtime cannot isolate logins");
  }
  return { id: account.id, home: account.home };
}

// events.account_id cannot be set after insert, so usage and quota carry it from the start.
export function accountTag(account: RunAccount | undefined): { accountId?: string } {
  return account === undefined ? {} : { accountId: account.id };
}

// Codex always runs on a per-run home, so the account's own home reaches it only as a copy.
export function accountRunEnv(spec: AgentSpec, account: RunAccount | null): Record<string, string> {
  return account === null || spec.id === "codex" ? {} : accountEnv(spec, account);
}

export interface RunCodexHome {
  home: string;
  // Stores a refreshed token back into the account; the default login has nothing to store.
  finish: (() => Promise<void>) | null;
}

export async function runCodexHome(
  spec: AgentSpec,
  runDir: string,
  account: RunAccount | null,
): Promise<RunCodexHome | null> {
  if (spec.id !== "codex") return null;
  if (account?.home == null) {
    return { home: await prepareCodexHome(runDir, codexRules()), finish: null };
  }
  return prepareAccountCodexHome(runDir, codexRules(), account.home);
}
