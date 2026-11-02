import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { loadConfig } from "../../config";

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

// Only read to move old keys out of the login Keychain, where an agent inside srt can run `security` on them.
const LEGACY_SERVICE = "harness";

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

const storeSchema = z.record(z.string(), z.string());

// Seatbelt blocks reads of this file in the kernel (sandbox.ts denies secrets.*). A Keychain read goes
// through securityd, which sits outside the sandbox.
const storePath = (home: string): string => join(home, "secrets.json");

async function readStore(home: string): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(storePath(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  return storeSchema.parse(JSON.parse(text));
}

async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Temp file in the same directory (same filesystem, also covered by the secrets.* deny), fsynced
// before the rename so a crash leaves either the old file or the new one.
async function writeStore(home: string, next: Record<string, string>): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  const tmp = `${storePath(home)}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(next));
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(tmp, storePath(home));
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  await syncDir(home);
}

// Read-modify-write, so writes are serialized to keep two stores from dropping each other's key.
let writing: Promise<unknown> = Promise.resolve();

function updateStore(home: string, provider: Provider, key: string): Promise<void> {
  const run = async (): Promise<void> =>
    writeStore(home, { ...(await readStore(home)), [provider]: key });
  const result = writing.then(run, run);
  writing = result.catch(() => undefined);
  return result;
}

async function readLegacy(provider: Provider, spawn: SecuritySpawn): Promise<string | null> {
  const { code, stdout } = await spawn([
    "security",
    "find-generic-password",
    "-s",
    LEGACY_SERVICE,
    "-a",
    provider,
    "-w",
  ]);
  return code === 0 ? stdout.replace(/\n$/, "") || null : null;
}

// Copy, check the copy reads back, and only then delete the login Keychain item. A failure before
// the delete leaves the Keychain item alone. A failed delete keeps the file entry: the key is safe
// in the store and the old item is only a leftover.
export async function migrateLegacy(
  home: string,
  spawn: SecuritySpawn,
  write: typeof updateStore = updateStore,
): Promise<void> {
  for (const provider of providers) {
    if ((await readStore(home))[provider]) continue;
    const legacy = await readLegacy(provider, spawn);
    if (!legacy) continue;
    await write(home, provider, legacy);
    if ((await readStore(home))[provider] !== legacy)
      throw new Error(`could not migrate the ${provider} key`);
    await spawn([
      "security",
      "delete-generic-password",
      "-s",
      LEGACY_SERVICE,
      "-a",
      provider,
    ]).catch(() => undefined);
  }
}

const migrations = new Map<string, Promise<void>>();

// Once per process and home; a failed attempt is retried on the next call.
function ready(home: string, spawn: SecuritySpawn): Promise<void> {
  let done = migrations.get(home);
  if (!done) {
    done = migrateLegacy(home, spawn);
    migrations.set(home, done);
    done.catch(() => migrations.delete(home));
  }
  return done;
}

async function fromStore(
  provider: Provider,
  spawn: SecuritySpawn,
  home: string,
): Promise<string | null> {
  await ready(home, spawn);
  return (await readStore(home))[provider] || null;
}

// The source stays "keychain" for the UI contract in shared/runs.ts.
export async function keyStatus(
  spawn: SecuritySpawn = spawnBounded,
  env: Env = process.env,
  home: string = loadConfig().home,
): Promise<Array<{ provider: Provider; source: "env" | "keychain" | null }>> {
  return Promise.all(
    providers.map(async (provider) => {
      if (fromEnv(provider, env)) return { provider, source: "env" as const };
      const stored = await fromStore(provider, spawn, home);
      return { provider, source: stored ? ("keychain" as const) : null };
    }),
  );
}

export async function getKey(
  provider: Provider,
  spawn: SecuritySpawn = spawnBounded,
  env: Env = process.env,
  home: string = loadConfig().home,
): Promise<string | null> {
  return fromEnv(provider, env) ?? (await fromStore(provider, spawn, home));
}

export async function storeKey(
  provider: Provider,
  key: string,
  home: string = loadConfig().home,
): Promise<void> {
  if (/\p{C}/u.test(key)) throw new Error("key must be printable text on a single line");
  await updateStore(home, provider, key);
}
