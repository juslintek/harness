import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadConfig } from "../../config";

const TIMEOUT_MS = 5000;
const NOT_FOUND = 127;
const TIMED_OUT = 124;

// A locked Keychain can prompt forever, so every call is bounded and a missing binary reads as "not found".
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

const storeSchema = z.record(z.string(), z.string());
const NAME = /^[a-z0-9._-]{1,64}$/;

function checkName(name: string): void {
  if (!NAME.test(name)) throw new Error("secret name must match [a-z0-9._-]{1,64}");
}

// Seatbelt blocks reads of this file in the kernel (sandbox.ts denies secrets.*). A Keychain read goes
// through securityd, which sits outside the sandbox.
const storePath = (home: string): string => join(home, "secrets.json");

// Names this module does not know are read back and written out again unchanged.
export function readSecrets(home: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(storePath(home), "utf8");
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

async function excludeFromBackup(home: string): Promise<void> {
  await backup.exclude(storePath(home)).catch((error) => {
    console.error("could not exclude secrets.json from backups", error);
  });
}

function syncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Temp file in the same directory (same filesystem, also covered by the secrets.* deny), fsynced
// before the rename so a crash leaves either the old file or the new one.
function writeSecrets(home: string, next: Record<string, string>): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const tmp = `${storePath(home)}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(next));
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, storePath(home));
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // already closed before the failing rename
    }
    try {
      unlinkSync(tmp);
    } catch {
      // the temp file may not exist any more
    }
    throw error;
  }
  syncDir(home);
}

// Read and write share one synchronous step, so two stores in this process cannot drop each other's
// key. With onlyIfMissing a key saved meanwhile is not overwritten. Returns whether it was written.
function putSecret(home: string, name: string, value: string, onlyIfMissing: boolean): boolean {
  checkName(name);
  const current = readSecrets(home);
  if (onlyIfMissing && current[name]) return false;
  writeSecrets(home, { ...current, [name]: value });
  return true;
}

export async function updateSecret(
  home: string,
  name: string,
  value: string,
  onlyIfMissing = false,
): Promise<boolean> {
  const written = putSecret(home, name, value, onlyIfMissing);
  if (written) await excludeFromBackup(home);
  return written;
}

export function getSecret(name: string, home: string = loadConfig().home): string | undefined {
  checkName(name);
  return readSecrets(home)[name] || undefined;
}

export function setSecret(name: string, value: string, home: string = loadConfig().home): void {
  putSecret(home, name, value, false);
  void excludeFromBackup(home);
}

export function deleteSecret(name: string, home: string = loadConfig().home): void {
  checkName(name);
  const { [name]: removed, ...rest } = readSecrets(home);
  if (removed !== undefined) {
    writeSecrets(home, rest);
    void excludeFromBackup(home);
  }
}

export function secretNames(home: string = loadConfig().home): string[] {
  return Object.keys(readSecrets(home)).sort();
}
