import { type AgentSpec, agentSpecs } from "./specs";

export type Runner = (
  argv: string[],
  timeoutMs: number,
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

async function bunRunner(
  argv: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
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

async function probeLogin(
  spec: AgentSpec,
  run: Runner,
): Promise<Pick<DiscoveredAgent, "loggedIn" | "error">> {
  if (!spec.loginProbe) return { loggedIn: null, error: null };
  try {
    const { code, stdout, stderr } = await run(spec.loginProbe.args, TIMEOUT_MS);
    const rule = spec.loginProbe.loggedInWhen;
    const loggedIn =
      code === 0 &&
      (rule === "exit0" ||
        stdout.includes(rule.stdoutIncludes) ||
        stderr.includes(rule.stdoutIncludes));
    return { loggedIn, error: null };
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
