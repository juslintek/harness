export const providers = ["anthropic", "openai", "gemini", "openrouter"] as const;
export type Provider = (typeof providers)[number];

export type SecuritySpawn = (
  argv: string[],
  stdin?: string,
) => Promise<{ code: number; stdout: string }>;
type Env = Record<string, string | undefined>;

const envNames: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const SERVICE = "harness";

const TIMEOUT_MS = 5000;
const NOT_FOUND = 127;
const TIMED_OUT = 124;

// A locked Keychain can prompt forever, so every call is bounded and a missing `security` reads as "no key".
export async function spawnBounded(
  argv: string[],
  stdin?: string,
  timeoutMs: number = TIMEOUT_MS,
): Promise<{ code: number; stdout: string }> {
  let proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn(argv, {
      stdin: stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return { code: NOT_FOUND, stdout: "" };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<{ code: number; stdout: string }>((resolve) => {
    timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ code: TIMED_OUT, stdout: "" });
    }, timeoutMs);
  });
  const finished = (async () => {
    if (stdin !== undefined) {
      (proc.stdin as Bun.FileSink).write(stdin);
      await (proc.stdin as Bun.FileSink).end();
    }
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code, stdout };
  })().catch(() => ({ code: NOT_FOUND, stdout: "" }));
  try {
    return await Promise.race([finished, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function fromEnv(provider: Provider, env: Env): string | null {
  return env[envNames[provider]] || null;
}

async function fromKeychain(provider: Provider, spawn: SecuritySpawn): Promise<string | null> {
  const { code, stdout } = await spawn([
    "security",
    "find-generic-password",
    "-s",
    SERVICE,
    "-a",
    provider,
    "-w",
  ]);
  return code === 0 ? stdout.replace(/\n$/, "") || null : null;
}

export async function keyStatus(
  spawn: SecuritySpawn = spawnBounded,
  env: Env = process.env,
): Promise<Array<{ provider: Provider; source: "env" | "keychain" | null }>> {
  return Promise.all(
    providers.map(async (provider) => {
      if (fromEnv(provider, env)) return { provider, source: "env" as const };
      const stored = await fromKeychain(provider, spawn);
      return { provider, source: stored ? ("keychain" as const) : null };
    }),
  );
}

export async function getKey(
  provider: Provider,
  spawn: SecuritySpawn = spawnBounded,
  env: Env = process.env,
): Promise<string | null> {
  return fromEnv(provider, env) ?? (await fromKeychain(provider, spawn));
}

// `security -i` tokenizes its stdin like a shell, so the value is double-quoted and escaped.
function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

export async function storeKey(
  provider: Provider,
  key: string,
  spawn: SecuritySpawn = spawnBounded,
): Promise<void> {
  if (/[\r\n]/.test(key)) throw new Error("key must be a single line");
  const command = `add-generic-password -U -s ${SERVICE} -a ${provider} -w ${quote(key)}\n`;
  const { code } = await spawn(["security", "-i"], command);
  if (code !== 0) throw new Error(`security exited with ${code}`);
}
