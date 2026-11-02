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
  // The parse errors quote the offending token, which can be a hand-typed key, so none of it is passed on.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${storePath(home)} is not valid JSON`);
  }
  const checked = storeSchema.safeParse(parsed);
  if (!checked.success) throw new Error(`${storePath(home)} has an unexpected shape`);
  return checked.data;
}

// Time Machine would copy the plaintext file to a backup disk. The exclusion is a per-file xattr that
// needs no admin rights; a failure is logged and never blocks the write.
export const backup = {
  exclude: async (file: string): Promise<void> => {
    const { code } = await spawnBounded(["tmutil", "addexclusion", file]);
    if (code !== 0) throw new Error(`tmutil exited with ${code}`);
  },
};

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
  await backup.exclude(storePath(home)).catch((error) => {
    console.error("could not exclude secrets.json from backups", error);
  });
}

// Read-modify-write, so writes are serialized to keep two stores from dropping each other's key.
let writing: Promise<unknown> = Promise.resolve();

// With onlyIfMissing the check and the write share one queue slot, so a key saved meanwhile is not
// overwritten. Resolves to whether the key was written.
function updateStore(
  home: string,
  provider: Provider,
  key: string,
  onlyIfMissing = false,
): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    const current = await readStore(home);
    if (onlyIfMissing && current[provider]) return false;
    await writeStore(home, { ...current, [provider]: key });
    return true;
  };
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

// Copy if the store lacks the key and check the copy reads back; the login Keychain item is deleted
// only while the store holds the same value, so a failed delete is retried on the next start and a
// different value in the store leaves the old item alone (it may be a user's valid key). A failure
// before the delete never deletes. Returns the providers whose old item is still in the Keychain.
export async function migrateLegacy(
  home: string,
  spawn: SecuritySpawn,
  write: typeof updateStore = updateStore,
): Promise<Provider[]> {
  const left: Provider[] = [];
  for (const provider of providers) {
    const legacy = await readLegacy(provider, spawn);
    if (!legacy) continue;
    const written = await write(home, provider, legacy, true);
    const stored = (await readStore(home))[provider];
    if (written && stored !== legacy) throw new Error(`could not migrate the ${provider} key`);
    if (stored !== legacy) {
      left.push(provider);
      continue;
    }
    const deleted = await spawn([
      "security",
      "delete-generic-password",
      "-s",
      LEGACY_SERVICE,
      "-a",
      provider,
    ]).catch(() => ({ code: 1 }));
    if (deleted.code !== 0) left.push(provider);
  }
  return left;
}

const migrations = new Map<string, Promise<Provider[]>>();

// Once per process and home; a failed attempt is retried on the next call.
function ready(home: string, spawn: SecuritySpawn): Promise<Provider[]> {
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

const warned = new Set<string>();

// `warn` is called once per process for each key whose old Keychain item is still there; it never
// gets the value.
export async function keyStatus(
  spawn: SecuritySpawn = spawnBounded,
  env: Env = process.env,
  home: string = loadConfig().home,
  warn: (provider: Provider) => void = () => undefined,
): Promise<Array<{ provider: Provider; source: "env" | "file" | null; legacyLeft: boolean }>> {
  const left = await ready(home, spawn);
  for (const provider of left) {
    if (warned.has(`${home}:${provider}`)) continue;
    warn(provider);
    warned.add(`${home}:${provider}`);
  }
  return Promise.all(
    providers.map(async (provider) => {
      const legacyLeft = left.includes(provider);
      if (fromEnv(provider, env)) return { provider, source: "env" as const, legacyLeft };
      const stored = await fromStore(provider, spawn, home);
      return { provider, source: stored ? ("file" as const) : null, legacyLeft };
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
