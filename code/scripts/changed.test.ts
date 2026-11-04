import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "changed.sh");
let root: string;
let work: string;

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

function guard(dir: string, cwd = work, stdin?: string): number {
  return Bun.spawnSync(["sh", SCRIPT, dir], {
    cwd,
    stdin: stdin === undefined ? undefined : Buffer.from(stdin),
  }).exitCode;
}

function head(): string {
  return Bun.spawnSync(["git", "-C", work, "rev-parse", "HEAD"]).stdout.toString().trim();
}

const pushLine = (oid: string): string => `refs/heads/x ${oid} refs/heads/x ${"0".repeat(40)}\n`;

function commit(file: string): void {
  mkdirSync(join(work, file, ".."), { recursive: true });
  writeFileSync(join(work, file), `${Math.random()}`);
  git(work, "add", "-A");
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", file);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "changed-"));
  work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  commit("code/a.ts");
  commit("zig/a.zig");
  // A local ref stands in for origin/main.
  git(work, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(work, "checkout", "-qb", "topic");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("skips (0) when nothing under the dir changed since origin/main", () => {
  expect(guard("code")).toBe(0);
});

test("runs the checks (1) only for the dir that changed, also from a subdirectory", () => {
  commit("code/b.ts");
  expect(guard("code")).toBe(1);
  expect(guard("zig")).toBe(0);
  expect(guard("code", join(work, "code"))).toBe(1);
});

test("compares the pushed commits from stdin, not the checked-out HEAD", () => {
  const topic = head();
  git(work, "checkout", "-qb", "docs-only", "origin/main");
  commit("zig/b.zig");
  const docsOnly = head();
  git(work, "checkout", "-qb", "code-change", "origin/main");
  commit("code/c.ts");
  const codeChange = head();
  git(work, "checkout", "-q", "topic");
  // HEAD (topic) changed code, but only the docs-only branch is being pushed.
  expect(guard("code", work, pushLine(docsOnly))).toBe(0);
  expect(guard("code", work, pushLine(codeChange))).toBe(1);
  expect(guard("code", work, pushLine(docsOnly) + pushLine(codeChange))).toBe(1);
  expect(guard("code", work, pushLine(topic))).toBe(1);
  // A deleted ref has an all-zero local oid and pushes nothing.
  expect(guard("code", work, pushLine("0".repeat(40)))).toBe(0);
  expect(guard("code", work, pushLine("0".repeat(40)) + pushLine(codeChange))).toBe(1);
});

test("unparsable stdin or an unknown pushed commit means run the checks", () => {
  expect(guard("code", work, "garbage\n")).toBe(1);
  expect(guard("code", work, pushLine("not-an-oid"))).toBe(1);
  expect(guard("code", work, pushLine("1".repeat(40)))).toBe(1);
  expect(guard("code", work, "\n \n")).toBe(1);
  // A sha256-length zero oid is not the deletion sentinel of this sha1 repo.
  expect(guard("code", work, pushLine("0".repeat(64)))).toBe(1);
});

test("fails closed: no dir, or no origin/main, means run the checks", () => {
  expect(guard("")).toBe(1);
  git(work, "update-ref", "-d", "refs/remotes/origin/main");
  expect(guard("zig")).toBe(1);
});
