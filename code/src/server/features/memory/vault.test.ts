import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNoteFile, removeNoteFile, vaultDir, writeNoteFileAtomic } from "./vault";

const homes: string[] = [];
function home(): string {
  const h = mkdtempSync(join(tmpdir(), "vault-"));
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

test("atomic write then read, private modes, no tmp left behind", () => {
  const h = home();
  const disk = "orgs/o1/org/sub/a.md";
  writeNoteFileAtomic(h, disk, "one");
  writeNoteFileAtomic(h, disk, "two");
  expect(readNoteFile(h, disk)).toBe("two");
  expect(statSync(join(vaultDir(h), disk)).mode & 0o777).toBe(0o600);
  expect(statSync(join(vaultDir(h), "orgs/o1/org/sub")).mode & 0o777).toBe(0o700);
  expect(readdirSync(join(vaultDir(h), "orgs/o1/org/sub"))).toEqual(["a.md"]);
  expect(readNoteFile(h, "orgs/o1/org/missing.md")).toBeNull();
});

test("a symlinked directory component blocks write, read and remove", () => {
  const h = home();
  const outside = home();
  mkdirSync(join(vaultDir(h), "orgs/o1"), { recursive: true });
  symlinkSync(outside, join(vaultDir(h), "orgs/o1/org"));
  expect(() => writeNoteFileAtomic(h, "orgs/o1/org/a.md", "x")).toThrow();
  expect(readdirSync(outside)).toEqual([]);
  expect(readNoteFile(h, "orgs/o1/org/a.md")).toBeNull();
  expect(() => removeNoteFile(h, "orgs/o1/org/a.md")).toThrow();
});

test("non-vault paths are refused and remove deletes the file", () => {
  const h = home();
  expect(() => writeNoteFileAtomic(h, ".git/config", "x")).toThrow();
  expect(() => writeNoteFileAtomic(h, "global/../../x.md", "x")).toThrow();
  writeNoteFileAtomic(h, "global/a.md", "x");
  removeNoteFile(h, "global/a.md");
  expect(readNoteFile(h, "global/a.md")).toBeNull();
  removeNoteFile(h, "global/a.md");
});

test("a symlinked leaf pointing outside the vault is never read or modified", () => {
  const h = home();
  const outside = join(home(), "secret.md");
  writeFileSync(outside, "outside");
  mkdirSync(join(vaultDir(h), "global"), { recursive: true });
  symlinkSync(outside, join(vaultDir(h), "global/a.md"));
  expect(readNoteFile(h, "global/a.md")).toBeNull();
  expect(() => writeNoteFileAtomic(h, "global/a.md", "x")).toThrow();
  expect(() => removeNoteFile(h, "global/a.md")).toThrow();
  expect(readFileSync(outside, "utf8")).toBe("outside");
});

test("a symlinked vault root is refused", () => {
  const h = home();
  const real = home();
  mkdirSync(join(real, "global"));
  writeFileSync(join(real, "global/a.md"), "x");
  symlinkSync(real, vaultDir(h));
  expect(readNoteFile(h, "global/a.md")).toBeNull();
  expect(() => writeNoteFileAtomic(h, "global/b.md", "x")).toThrow();
  expect(() => removeNoteFile(h, "global/a.md")).toThrow();
  expect(readdirSync(join(real, "global"))).toEqual(["a.md"]);
});
