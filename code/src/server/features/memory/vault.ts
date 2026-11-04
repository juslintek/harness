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
import { diskToLocated } from "./paths";

export function vaultDir(home: string): string {
  return join(home, "memory");
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
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

export function readNoteFile(home: string, disk: string): string | null {
  if (diskToLocated(disk) === null || hasSymlink(home, disk)) return null;
  try {
    return readFileSync(join(vaultDir(home), disk), "utf8");
  } catch {
    return null;
  }
}

export function writeNoteFileAtomic(home: string, disk: string, text: string): void {
  const file = checked(home, disk);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // mkdir -p applies the umask to parents; the vault should stay private.
  for (let d = dirname(file); d.length > vaultDir(home).length; d = dirname(d)) chmodSync(d, 0o700);
  if (hasSymlink(home, disk)) throw new Error(`symlink in note path: ${disk}`);
  const tmp = `${file}.${Bun.randomUUIDv7()}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

export function removeNoteFile(home: string, disk: string): void {
  rmSync(checked(home, disk), { force: true });
}
