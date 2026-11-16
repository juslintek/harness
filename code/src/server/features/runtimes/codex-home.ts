import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Per run and rebuilt from scratch, so nothing an earlier run wrote (rules, config) survives.
async function freshHome(runDir: string, rulesText: string): Promise<string> {
  const home = join(runDir, "codex-home");
  await rm(home, { recursive: true, force: true });
  await mkdir(join(home, "rules"), { recursive: true });
  await Bun.write(join(home, "rules", "harness.rules"), rulesText);
  return home;
}

// The default login: only auth.json is linked, the user's config.toml and rules must not reach the run.
export async function prepareCodexHome(
  runDir: string,
  rulesText: string,
  realCodexDir: string = join(homedir(), ".codex"),
): Promise<string> {
  const home = await freshHome(runDir, rulesText);
  await symlink(join(realCodexDir, "auth.json"), join(home, "auth.json"));
  return home;
}

// One chain per account home. Harness is the only writer of these files, so an in-process lock is
// enough to keep a copy-in from reading while a write-back is renaming.
const tails = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (tails.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

// A run can write anything into its own home, so a link or a huge file there must not be followed
// or copied into the account's home by Harness, which can read what the sandbox cannot.
async function readRegular(path: string): Promise<string | null> {
  // O_NONBLOCK: opening a FIFO the run planted would otherwise wait for a writer and hold the lock.
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(path, flags).catch(() => null);
  if (handle === null) return null;
  try {
    const info = await handle.stat();
    return info.isFile() && info.size <= 1 << 20 ? await handle.readFile("utf8") : null;
  } finally {
    await handle.close();
  }
}

// The copied-in token, kept beside the run's home rather than in it: srt lets the run write only
// its home, so the run cannot change what a write-back compares against. On disk so that a restart
// can still store a token the run refreshed before the harness died.
const baselineOf = (runDir: string): string => join(runDir, "codex-auth.base");

// A non-default account keeps its login in its own home. The run gets a copy, never a link: srt
// blocks a write through a link, so a token refresh would fail, and a link would let the run
// reach the account's directory.
export async function prepareAccountCodexHome(
  runDir: string,
  rulesText: string,
  accountHome: string,
): Promise<{ home: string; finish: () => Promise<void> }> {
  const home = await freshHome(runDir, rulesText);
  const mine = join(home, "auth.json");
  const copied = await withLock(accountHome, async () => {
    await copyFile(join(accountHome, "auth.json"), mine);
    return readRegular(mine);
  });
  // No baseline would make every run look like it changed the file.
  if (copied === null) {
    await rm(mine, { force: true });
    throw new Error("account auth.json is not a regular file under 1 MiB");
  }
  try {
    await writeFile(baselineOf(runDir), copied, { mode: 0o600 });
  } catch (err) {
    // The caller never gets a finish hook, so nothing else would remove the plaintext copy.
    await Promise.allSettled([rm(mine, { force: true }), rm(baselineOf(runDir), { force: true })]);
    throw err;
  }
  return { home, finish: () => writeBackAccountAuth(runDir, accountHome) };
}

// Written back only when the run changed its copy and the account's file is still what it copied
// in: a newer token from another run, or a new login, must not be replaced by an older one. The
// run's plaintext copy and the baseline are removed either way; a second call finds no baseline.
export function writeBackAccountAuth(runDir: string, accountHome: string): Promise<void> {
  const home = join(runDir, "codex-home");
  const mine = join(home, "auth.json");
  const theirs = join(accountHome, "auth.json");
  const baseline = baselineOf(runDir);
  return withLock(accountHome, async () => {
    try {
      const copied = await readRegular(baseline);
      if (copied === null) return;
      // O_NOFOLLOW guards only the last path component. The run cannot write its run dir, so the
      // resolved path must still be the copy inside it; this also catches a symlink the run put in
      // place of its home directory.
      const mineReal = join(await realpath(runDir), "codex-home", "auth.json");
      if ((await realpath(mine).catch(() => null)) !== mineReal) return;
      const after = await readRegular(mine);
      if (after === null || after === copied) return;
      if ((await readRegular(theirs)) !== copied) return;
      const tmp = join(accountHome, `.auth.json.${Bun.randomUUIDv7()}.tmp`);
      try {
        await writeFile(tmp, after, { mode: 0o600 });
        await rename(tmp, theirs);
      } finally {
        await rm(tmp, { force: true });
      }
    } finally {
      // Never through a home the run swapped for a link, which could point at another account.
      if ((await lstat(home).catch(() => null))?.isDirectory()) await rm(mine, { force: true });
      await rm(baseline, { force: true });
    }
  });
}
