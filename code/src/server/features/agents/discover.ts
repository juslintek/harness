import type { AccountState } from "../../../shared/accounts";
import { identityHint } from "./identity-hint";
import { type AgentSpec, accountEnv, agentSpecs } from "./specs";

export type Runner = (
  argv: string[],
  timeoutMs: number,
  env?: Record<string, string>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface DiscoveredAgent {
  id: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  loggedIn: boolean | null;
  error: string | null;
}

const TIMEOUT_MS = 5000;
const NOT_FOUND = 127;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function bunRunner(
  argv: string[],
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      ...(env && { env: { ...process.env, ...env } }),
    });
  } catch (err) {
    return { code: NOT_FOUND, stdout: "", stderr: errorText(err) };
  }
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (proc.signalCode) throw new Error(`timed out after ${timeoutMs} ms`);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

function parseVersion(text: string): string | null {
  return text.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? null;
}

function loggedInBy(
  spec: AgentSpec,
  out: { code: number; stdout: string; stderr: string },
): boolean {
  const rule = spec.loginProbe?.loggedInWhen;
  if (!rule) return false;
  return (
    out.code === 0 &&
    (rule === "exit0" ||
      out.stdout.includes(rule.stdoutIncludes) ||
      out.stderr.includes(rule.stdoutIncludes))
  );
}

async function probeLogin(
  spec: AgentSpec,
  run: Runner,
): Promise<Pick<DiscoveredAgent, "loggedIn" | "error">> {
  if (!spec.loginProbe) return { loggedIn: null, error: null };
  try {
    const { code, stdout, stderr } = await run(
      spec.loginProbe.args,
      TIMEOUT_MS,
      spec.loginProbe.env,
    );
    return { loggedIn: loggedInBy(spec, { code, stdout, stderr }), error: null };
  } catch (err) {
    return { loggedIn: null, error: errorText(err) };
  }
}

async function discoverOne(spec: AgentSpec, run: Runner): Promise<DiscoveredAgent> {
  const missing = { id: spec.id, installed: false, path: null, version: null, loggedIn: null };
  if (spec.id === "gemini" && !process.env.GEMINI_API_KEY) {
    return { ...missing, error: "GEMINI_API_KEY is not set" };
  }
  try {
    const version = await run(spec.versionArgs, TIMEOUT_MS);
    if (version.code !== 0) {
      const error =
        version.code === NOT_FOUND ? null : version.stderr.trim() || `exit ${version.code}`;
      return { ...missing, error };
    }
    const which = await run(["which", spec.versionArgs[0] as string], TIMEOUT_MS);
    return {
      id: spec.id,
      installed: true,
      path: which.code === 0 ? which.stdout.trim() || null : null,
      version: parseVersion(version.stdout),
      ...(await probeLogin(spec, run)),
    };
  } catch (err) {
    return { ...missing, error: errorText(err) };
  }
}

export function discoverAgents(run: Runner = bunRunner): Promise<DiscoveredAgent[]> {
  return Promise.all(agentSpecs.map((spec) => discoverOne(spec, run)));
}

export interface AccountProbe {
  state: Extract<AccountState, "active" | "logged_out" | "probe_failed">;
  identityHint: string | null;
}

// The probe keeps whatever env the spec pins (Codex reads ~/.codex) and lets the account's own
// home replace it. A NULL home adds nothing, which is today's behaviour.
function probeEnv(
  spec: AgentSpec,
  account: { home: string | null },
): Record<string, string> | undefined {
  const env = { ...spec.loginProbe?.env, ...accountEnv(spec, account) };
  return Object.keys(env).length > 0 ? env : undefined;
}

export async function probeAccount(
  spec: AgentSpec,
  account: { home: string | null },
  run: Runner = bunRunner,
): Promise<AccountProbe> {
  const failed: AccountProbe = { state: "probe_failed", identityHint: null };
  if (!spec.loginProbe) return failed;
  try {
    const out = await run(spec.loginProbe.args, TIMEOUT_MS, probeEnv(spec, account));
    if (out.code === NOT_FOUND) return failed;
    if (!loggedInBy(spec, out)) return { state: "logged_out", identityHint: null };
    return { state: "active", identityHint: identityHint(spec.id, out.stdout) };
  } catch {
    return failed;
  }
}

// Best effort: the vendor name for this command is not verified against a real CLI, so a failure
// is reported to the caller and never blocks removing the local home.
export async function logoutAccount(
  spec: AgentSpec,
  account: { home: string | null },
  run: Runner = bunRunner,
): Promise<"logged out" | "logout failed" | "no logout command"> {
  if (!spec.logoutArgs || account.home === null) return "no logout command";
  try {
    const out = await run(spec.logoutArgs, TIMEOUT_MS, accountEnv(spec, account));
    return out.code === 0 ? "logged out" : "logout failed";
  } catch {
    return "logout failed";
  }
}
