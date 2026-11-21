import { afterAll, expect, test } from "bun:test";
import {
  linkSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareAccountCodexHome, prepareCodexHome } from "./codex-home";

const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-home-")));
afterAll(() => rm(root, { recursive: true, force: true }));

test("creates codex-home with symlinked auth and the rules file", async () => {
  const fakeReal = join(root, "real-codex");
  await mkdir(fakeReal);
  await Bun.write(join(fakeReal, "auth.json"), "{}");
  await Bun.write(join(fakeReal, "config.toml"), "secret = 1");
  const runDir = join(root, "run1");
  const rules = 'prefix_rule(pattern=["rm", "-rf", "/"], decision="forbidden")\n';

  const home = await prepareCodexHome(runDir, rules, fakeReal);

  expect(home).toBe(join(runDir, "codex-home"));
  expect(lstatSync(join(home, "auth.json")).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(home, "auth.json"))).toBe(join(fakeReal, "auth.json"));
  expect(readFileSync(join(home, "rules/harness.rules"), "utf8")).toBe(rules);
  expect(() => lstatSync(join(home, "config.toml"))).toThrow();
  expect(readFileSync(join(fakeReal, "config.toml"), "utf8")).toBe("secret = 1");
});

test("a second prepare drops anything the previous run left behind", async () => {
  const fakeReal = join(root, "real3");
  await mkdir(fakeReal);
  const runDir = join(root, "run3");
  const home = await prepareCodexHome(runDir, "a", fakeReal);
  await Bun.write(join(home, "rules", "evil.rules"), "x");
  await Bun.write(join(home, "config.toml"), "x");
  await prepareCodexHome(runDir, "b", fakeReal);
  expect(() => lstatSync(join(home, "rules", "evil.rules"))).toThrow();
  expect(() => lstatSync(join(home, "config.toml"))).toThrow();
});

test("is idempotent and rewrites the rules", async () => {
  const fakeReal = join(root, "real2");
  await mkdir(fakeReal);
  const runDir = join(root, "run2");
  await prepareCodexHome(runDir, "a", fakeReal);
  const home = await prepareCodexHome(runDir, "b", fakeReal);
  expect(readFileSync(join(home, "rules/harness.rules"), "utf8")).toBe("b");
});

test("concurrent write-backs on one account: the first wins, the file is replaced whole with 0600", async () => {
  const dir = mkdtempSync(join(root, "acct-"));
  const home = join(dir, "accounts", "b");
  await mkdir(home, { recursive: true });
  const theirs = join(home, "auth.json");
  writeFileSync(theirs, '{"v":1}', { mode: 0o644 });
  // A reader that opened the old file must keep seeing it whole, so the file is swapped, not
  // rewritten in place.
  const reader = join(dir, "reader.json");
  linkSync(theirs, reader);
  const runs = await Promise.all(
    [0, 1, 2, 3, 4, 5, 6, 7].map((n) => prepareAccountCodexHome(join(dir, `r${n}`), "", home)),
  );
  for (const [n, run] of runs.entries())
    writeFileSync(join(run.home, "auth.json"), `{"v":${n + 2}}`);
  await Promise.all(runs.map((run) => run.finish()));
  // All copied in v1, so once the first stored its refresh, the older tokens must not replace it.
  expect(readFileSync(theirs, "utf8")).toBe('{"v":2}');
  expect(statSync(theirs).mode & 0o777).toBe(0o600);
  expect(readFileSync(reader, "utf8")).toBe('{"v":1}');
  expect(readdirSync(home)).toEqual(["auth.json"]);
});

test("a run that did not change auth.json leaves the account file alone", async () => {
  const dir = mkdtempSync(join(root, "acct-"));
  const home = join(dir, "accounts", "b");
  await mkdir(home, { recursive: true });
  const theirs = join(home, "auth.json");
  writeFileSync(theirs, '{"v":1}', { mode: 0o644 });
  const before = statSync(theirs);
  const { finish } = await prepareAccountCodexHome(join(dir, "run"), "", home);
  await finish();
  const after = statSync(theirs);
  expect(after.ino).toBe(before.ino);
  expect(after.mode & 0o777).toBe(0o644);
});

test("a run that swaps auth.json for a FIFO cannot hang the write-back, and an oversized account file is refused", async () => {
  const dir = mkdtempSync(join(root, "acct-"));
  const home = join(dir, "accounts", "b");
  await mkdir(home, { recursive: true });
  writeFileSync(join(home, "auth.json"), '{"v":1}');
  const { home: runHome, finish } = await prepareAccountCodexHome(join(dir, "run"), "", home);
  rmSync(join(runHome, "auth.json"));
  expect(Bun.spawnSync(["mkfifo", join(runHome, "auth.json")]).exitCode).toBe(0);
  await finish();
  expect(readFileSync(join(home, "auth.json"), "utf8")).toBe('{"v":1}');
  writeFileSync(join(home, "auth.json"), "x".repeat((1 << 20) + 1));
  await expect(prepareAccountCodexHome(join(dir, "run2"), "", home)).rejects.toThrow(
    "regular file",
  );
});

test("a run that points its home at another account's home cannot copy that login into its own account", async () => {
  const dir = mkdtempSync(join(root, "acct-"));
  const home = join(dir, "accounts", "b");
  const other = join(dir, "accounts", "c");
  for (const h of [home, other]) await mkdir(h, { recursive: true });
  writeFileSync(join(home, "auth.json"), '{"who":"b"}');
  writeFileSync(join(other, "auth.json"), '{"who":"c"}');
  const { home: runHome, finish } = await prepareAccountCodexHome(join(dir, "run"), "", home);
  renameSync(runHome, `${runHome}.moved`);
  symlinkSync(other, runHome);
  await finish();
  expect(readFileSync(join(home, "auth.json"), "utf8")).toBe('{"who":"b"}');
});
