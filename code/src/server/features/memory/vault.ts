import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { hashText } from "./frontmatter";
import { diskToLocated } from "./paths";

export function vaultDir(home: string): string {
  return join(home, "memory");
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (e) {
    // A missing component is fine (first write); any other error means we cannot vouch for the path.
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

// Checks the vault root and every component below it, so an outside editor
// cannot redirect a write out of the vault by swapping a directory for a link.
function hasSymlink(home: string, disk: string): boolean {
  let cur = vaultDir(home);
  if (isSymlink(cur)) return true;
  for (const part of disk.split("/")) {
    cur = join(cur, part);
    if (isSymlink(cur)) return true;
  }
  return false;
}

function checked(home: string, disk: string): string {
  if (diskToLocated(disk) === null) throw new Error(`invalid note path: ${disk}`);
  if (hasSymlink(home, disk)) throw new Error(`symlink in note path: ${disk}`);
  return join(vaultDir(home), disk);
}

// Notes can hold what agents learned about customers, so the vault must be private to this user.
// lstat first: chmod follows links and would loosen or tighten whatever the link points at.
export function securePrivateVault(home: string): void {
  const dir = vaultDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fail = (why: string): never => {
    throw new Error(`memory vault ${dir} is not usable: ${why}`);
  };
  const before = lstatSync(dir);
  if (before.isSymbolicLink() || !before.isDirectory()) fail("not a real directory");
  if (before.uid !== process.getuid?.()) fail("owned by another user");
  chmodSync(dir, 0o700);
  if ((lstatSync(dir).mode & 0o777) !== 0o700) fail("mode is not 0700 after chmod");
}

export function readNoteFile(home: string, disk: string): string | null {
  if (diskToLocated(disk) === null || hasSymlink(home, disk)) return null;
  try {
    const file = join(vaultDir(home), disk);
    // Reading a FIFO named *.md would block the event loop.
    if (!lstatSync(file).isFile()) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export class FileChanged extends Error {}

// Seam for tests: runs in the gap between the last check and the rename or unlink.
let beforeSwap: (() => void) | null = null;

export function setBeforeSwapHook(fn: (() => void) | null): void {
  beforeSwap = fn;
}

// The caller checked the base hash a moment ago, but an outside editor is not bound by our lock.
// Re-hashing right before the rename or unlink shrinks that window to a few microseconds; it cannot
// close it, since no lock held by this process stops another program writing the file.
function assertUnchanged(home: string, disk: string, expected: string | null): void {
  beforeSwap?.();
  const current = readNoteFile(home, disk);
  if ((current === null ? null : hashText(current)) !== expected) {
    throw new FileChanged("note changed since it was read");
  }
}

// `expected` is the hash of the text being replaced, or null when the file must not exist yet.
export function writeNoteFileAtomic(
  home: string,
  disk: string,
  text: string,
  expected: string | null,
): void {
  const file = checked(home, disk);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // mkdir -p applies the umask to parents; the vault should stay private.
  for (let d = dirname(file); d.length > vaultDir(home).length; d = dirname(d)) chmodSync(d, 0o700);
  if (hasSymlink(home, disk)) throw new Error(`symlink in note path: ${disk}`);
  const tmp = `${file}.${Bun.randomUUIDv7()}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    assertUnchanged(home, disk, expected);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export function removeNoteFile(home: string, disk: string, expected: string): void {
  const file = checked(home, disk);
  assertUnchanged(home, disk, expected);
  rmSync(file, { force: true });
}
