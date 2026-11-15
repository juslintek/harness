import type { Database } from "bun:sqlite";
import type { AccountView } from "../../../shared/accounts";
import { appendEvent } from "../logs/api";
import { AccountError, accountOf, assertIsolated, auditAccount } from "./accounts-ops";
import * as repo from "./accounts-repo";
import { forgetDiscovery, getSpec, LoginError, type LoginProcess } from "./api";
import { probeAccount, type Runner } from "./discover";
import { forgetLogin, runningLogin, trackLogin } from "./login-registry";
import { type AgentSpec, accountEnv } from "./specs";

type AccountSpawn = (argv: string[], env: Record<string, string>) => LoginProcess;

// Everything the real CLI would otherwise supply, so tests run the same code against fakes.
export interface AccountDeps {
  spawn?: AccountSpawn;
  timeoutMs?: number;
  spec?: AgentSpec | null;
  run?: Runner;
  afterExit?: () => void;
}

const LOGIN_TIMEOUT_MS = 600_000;

// Only the account's own variables are added, on top of the server's environment.
function spawnLogin(argv: string[], env: Record<string, string>): LoginProcess {
  return Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, ...env },
  });
}

function specFor(deps: AccountDeps, runtime: string): AgentSpec {
  const spec = deps.spec === undefined ? getSpec(runtime) : deps.spec;
  if (!spec) throw new AccountError(404, "unknown agent");
  return spec;
}

const INACTIVE = ["disabled", "removing", "removed"];

// A login or a test must not bring a disabled or removed account back, and a non-default account
// only runs where isolation is verified.
function usableSpec(account: AccountView, deps: AccountDeps): AgentSpec {
  if (INACTIVE.includes(account.state))
    throw new AccountError(409, `the account is ${account.state}`);
  const spec = specFor(deps, account.runtime);
  if (account.home !== null) assertIsolated(spec);
  return spec;
}

export async function testAccount(
  db: Database,
  runtime: string,
  id: string,
  deps: AccountDeps = {},
): Promise<AccountView> {
  const account = accountOf(db, runtime, id);
  const spec = usableSpec(account, deps);
  const probe = await probeAccount(spec, account, deps.run);
  // The probe takes a while; the holder may have disabled or removed the account meanwhile.
  const current = accountOf(db, runtime, id);
  if (INACTIVE.includes(current.state))
    throw new AccountError(409, `the account is ${current.state}`);
  const updated = repo.updateAccount(db, id, {
    state: probe.state,
    identityHint: probe.identityHint,
    lastProbeAt: Date.now(),
  });
  if (!updated) throw new AccountError(404, "unknown account");
  auditAccount(db, "account.tested", updated, probe.state);
  return updated;
}

async function testAfterLogin(
  db: Database,
  runtime: string,
  id: string,
  deps: AccountDeps,
): Promise<void> {
  try {
    await testAccount(db, runtime, id, deps);
  } catch (err) {
    // Disabled or removed while the login ran: the holder's later choice wins, nothing to report.
    if (err instanceof AccountError) return;
    appendEvent(db, {
      kind: "error",
      source: "accounts",
      agent: runtime,
      body: `test after login failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

export function startAccountLogin(
  db: Database,
  runtime: string,
  id: string,
  deps: AccountDeps = {},
): { command: string[] } {
  const account = accountOf(db, runtime, id);
  const spec = usableSpec(account, deps);
  const command = spec.loginArgs;
  if (!command) throw new LoginError(`no login command for ${runtime}`);
  const running = runningLogin(id);
  if (running) return { command: running };
  let proc: LoginProcess;
  try {
    proc = (deps.spawn ?? spawnLogin)(command, accountEnv(spec, account));
  } catch {
    throw new LoginError(`${command[0]} could not be started, is it installed?`);
  }
  trackLogin(id, command, proc);
  const timer = setTimeout(() => proc.kill(), deps.timeoutMs ?? LOGIN_TIMEOUT_MS);
  const done = (): void => {
    clearTimeout(timer);
    forgetLogin(id);
    (deps.afterExit ?? forgetDiscovery)();
    void testAfterLogin(db, runtime, id, deps);
  };
  proc.exited.then(done, done);
  return { command };
}
