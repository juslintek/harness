import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  guardHookArg,
  isCompiledBinary,
  resolvePackagedAdapter,
  resolveSeccompApplyPath,
  resolveUiDist,
} from "./packaged";

const dirs: string[] = [];
function tempRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "harness-packaged-")));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("isCompiledBinary detects Bun virtual filesystem paths only", () => {
  expect(isCompiledBinary("/$bunfs/root/src/server")).toBe(true);
  expect(isCompiledBinary("B:/~BUN/root/src/server")).toBe(true);
  expect(isCompiledBinary("/Users/dev/harness/code/src/server")).toBe(false);
  expect(guardHookArg("/$bunfs/root/scripts/guard-hook.ts", true)).toBe("guard-hook");
  expect(guardHookArg("/$bunfs/root/scripts/guard-hook.ts", false)).toBe(
    "/$bunfs/root/scripts/guard-hook.ts",
  );
});

test("resolveUiDist prefers HARNESS_UI_DIST, then packaged share/sibling layouts when compiled", () => {
  const root = tempRoot();
  const binDir = join(root, "prefix", "bin");
  const shareUi = join(root, "prefix", "share", "harness", "ui");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(shareUi, { recursive: true });
  const exe = join(binDir, "harness");
  writeFileSync(exe, "");
  writeFileSync(join(shareUi, "index.html"), "<!doctype html><title>Solid</title>");

  // Explicit HARNESS_UI_DIST always wins.
  expect(resolveUiDist({ HARNESS_UI_DIST: "/custom/ui" }, { execPath: exe, compiled: true })).toBe(
    "/custom/ui",
  );
  // In source checkout mode (not compiled, no HARNESS_SHARE_DIR), do not auto-pick packaged UI.
  expect(resolveUiDist({}, { execPath: exe, compiled: false })).toBeUndefined();
  // In compiled mode, auto-detect ../share/harness/ui relative to binary.
  expect(resolveUiDist({}, { execPath: exe, compiled: true })).toBe(shareUi);

  // A sibling ui/ directory right next to the binary wins over ../share/harness/ui.
  const siblingUi = join(binDir, "ui");
  mkdirSync(siblingUi, { recursive: true });
  writeFileSync(join(siblingUi, "index.html"), "<!doctype html><title>Sibling</title>");
  expect(resolveUiDist({}, { execPath: exe, compiled: true })).toBe(siblingUi);

  // HARNESS_SHARE_DIR overrides sibling lookup and works even outside compiled mode.
  const customShare = join(root, "custom-share");
  mkdirSync(join(customShare, "ui"), { recursive: true });
  writeFileSync(join(customShare, "ui", "index.html"), "<!doctype html>");
  expect(
    resolveUiDist({ HARNESS_SHARE_DIR: customShare }, { execPath: exe, compiled: false }),
  ).toBe(join(customShare, "ui"));
});

test("resolveUiDist follows symlinked executables to their packaged share directory", () => {
  const root = tempRoot();
  const realBinDir = join(root, "opt", "harness", "bin");
  const shareUi = join(root, "opt", "harness", "share", "harness", "ui");
  const linkDir = join(root, "usr-bin");
  mkdirSync(realBinDir, { recursive: true });
  mkdirSync(shareUi, { recursive: true });
  mkdirSync(linkDir, { recursive: true });
  const realExe = join(realBinDir, "harness");
  writeFileSync(realExe, "");
  writeFileSync(join(shareUi, "index.html"), "<!doctype html>");
  const linkExe = join(linkDir, "harness");
  symlinkSync(realExe, linkExe);

  expect(resolveUiDist({}, { execPath: linkExe, compiled: true })).toBe(shareUi);
});

test("resolveSeccompApplyPath finds Linux seccomp helper and returns null on non-Linux", () => {
  const root = tempRoot();
  const binDir = join(root, "bin");
  const seccomp = join(root, "share", "harness", "vendor", "seccomp", "x64", "apply-seccomp");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(root, "share", "harness", "vendor", "seccomp", "x64"), { recursive: true });
  const exe = join(binDir, "harness");
  writeFileSync(exe, "");
  writeFileSync(seccomp, "");

  expect(
    resolveSeccompApplyPath({}, { execPath: exe, platform: "darwin", arch: "arm64" }),
  ).toBeNull();
  expect(resolveSeccompApplyPath({}, { execPath: exe, platform: "linux", arch: "x64" })).toBe(
    seccomp,
  );
  expect(
    resolveSeccompApplyPath({}, { execPath: exe, platform: "linux", arch: "arm64" }),
  ).toBeNull();
});

test("resolvePackagedAdapter finds bundled adapter scripts in share directory", () => {
  const root = tempRoot();
  const binDir = join(root, "bin");
  const adapters = join(root, "share", "harness", "adapters");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(adapters, { recursive: true });
  const exe = join(binDir, "harness");
  const codex = join(adapters, "codex-acp.mjs");
  writeFileSync(exe, "");
  writeFileSync(codex, "");

  expect(resolvePackagedAdapter("codex-acp.mjs", {}, { execPath: exe })).toBe(codex);
  expect(resolvePackagedAdapter("missing.mjs", {}, { execPath: exe })).toBeNull();
});
