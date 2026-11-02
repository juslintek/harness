import { afterAll, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCodexHome } from "./codex-home";

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
