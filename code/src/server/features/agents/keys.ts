import { loadConfig } from "../../config";
import {
  spawnBounded as boundedSpawn,
  backup as fileBackup,
  readSecrets,
  updateSecret,
} from "./secrets-file";

// Same objects as in secrets-file; kept under these names for the callers that already use them.
export const backup: typeof fileBackup = fileBackup;
export const spawnBounded: typeof boundedSpawn = boundedSpawn;

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

function fromEnv(provider: Provider, env: Env): string | null {
  return env[envNames[provider]] || null;
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
  write: typeof updateSecret = updateSecret,
): Promise<Provider[]> {
  const left: Provider[] = [];
  for (const provider of providers) {
    const legacy = await readLegacy(provider, spawn);
    if (!legacy) continue;
    const written = await write(home, provider, legacy, true);
    const stored = readSecrets(home)[provider];
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
  return readSecrets(home)[provider] || null;
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
  await updateSecret(home, provider, key);
}
