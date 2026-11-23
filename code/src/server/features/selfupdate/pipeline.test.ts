import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePackagedAdapter, resolveSeccompApplyPath, resolveUiDist } from "../../packaged";
import { makeHome, makeRepo, script, tempDir } from "../../test-support/selfupdate-kit";
import { type PipelineDeps, preserveShareDir, runPipeline } from "./pipeline";
import { createRequest, getRequest } from "./requests";
import { resolveCommit } from "./steps";

setDefaultTimeout(30_000);

let home: string;
let marks: string;
let shutdowns = 0;
let repo = "";

async function run(steps: Partial<PipelineDeps["steps"]>): Promise<ReturnType<typeof getRequest>> {
  const ctx = makeHome();
  home = ctx.home;
  const commitSha = await resolveCommit(repo, "main");
  const req = createRequest(ctx.db, { repo, branch: "main", commitSha, createdBy: "u1" });
  await runPipeline(ctx.db, req.id, {
    home,
    port: 1,
    pid: process.pid,
    liveBinary: "/bin/true",
    runningCommit: commitSha,
    verifyMs: 3000,
    beginShutdown: () => {
      shutdowns++;
    },
    steps: {
      install: ["true"],
      check: ["true"],
      build: (out) => ["sh", "-c", `touch "${marks}/built"; echo "${out}/none"`],
      expectedVersion: "2.0.0",
      ...steps,
    },
  });
  return getRequest(ctx.db, req.id);
}

beforeEach(async () => {
  repo = await makeRepo("1.0.0");
  marks = tempDir("marks");
  shutdowns = 0;
});

describe("a pipeline that fails before the swap", () => {
  test("a failing check stops before build and leaves the live process alone", async () => {
    const req = await run({ check: ["sh", "-c", "echo boom; exit 3"] });
    expect(req?.status).toBe("failed");
    expect(req?.log).toContain("boom");
    expect(existsSync(join(marks, "built"))).toBe(false);
    expect(shutdowns).toBe(0);
    expect(existsSync(join(home, "bin"))).toBe(false);
  });

  test("a check that leaves changes in the worktree stops before build", async () => {
    const req = await run({ check: ["sh", "-c", "echo x > injected.ts"] });
    expect(req?.status).toBe("failed");
    expect(req?.reason).toContain("worktree is not clean");
    expect(existsSync(join(marks, "built"))).toBe(false);
    expect(shutdowns).toBe(0);
  });

  test("a failing build stops before the scratch start", async () => {
    const req = await run({ build: () => ["sh", "-c", "echo nope; exit 1"] });
    expect(req?.status).toBe("failed");
    expect(shutdowns).toBe(0);
    expect(existsSync(join(home, "snapshots"))).toBe(false);
  });

  test("a new binary that is unhealthy on the scratch copy stops before the swap", async () => {
    const bad = script(tempDir("bad"), "harness-bad", "exit 1");
    const req = await run({ build: () => ["echo", bad] });
    expect(req?.status).toBe("failed");
    expect(req?.reason).toContain("exited before listening");
    expect(shutdowns).toBe(0);
    expect(existsSync(join(home, "bin", "current"))).toBe(false);
    expect(existsSync(join(home, "snapshots", `${req?.id}-swap.db`))).toBe(false);
  });

  test("the worktree is removed afterwards", async () => {
    await run({ check: ["false"] });
    const list = Bun.spawnSync(["git", "worktree", "list"], { cwd: repo }).stdout.toString();
    expect(list.trim().split("\n")).toHaveLength(1);
  });
});

describe("preserveShareDir", () => {
  test("links installed share assets into harness home across first and subsequent swaps", () => {
    const prefix = realpathSync(tempDir("pkg-prefix"));
    const harnessHome = realpathSync(tempDir("pkg-home"));
    const oldBin = join(prefix, "bin", "harness");
    const origShare = join(prefix, "share", "harness");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    mkdirSync(join(origShare, "ui"), { recursive: true });
    mkdirSync(join(origShare, "adapters"), { recursive: true });
    mkdirSync(join(origShare, "vendor", "seccomp", "x64"), { recursive: true });
    writeFileSync(oldBin, "");
    writeFileSync(join(origShare, "ui", "index.html"), "<!doctype html>");
    writeFileSync(join(origShare, "adapters", "codex-acp.mjs"), "");
    writeFileSync(join(origShare, "vendor", "seccomp", "x64", "apply-seccomp"), "");

    const firstShare = preserveShareDir(harnessHome, oldBin, {});
    expect(firstShare).toBe(origShare);
    const updatedBin = join(harnessHome, "bin", "harness-u1");
    mkdirSync(join(harnessHome, "bin"), { recursive: true });
    writeFileSync(updatedBin, "");

    // Even with an empty env (e.g. after a service restart), the updated binary finds all assets.
    expect(resolveUiDist({}, { execPath: updatedBin, compiled: true })).toBe(
      join(harnessHome, "share", "harness", "ui"),
    );
    expect(resolvePackagedAdapter("codex-acp.mjs", {}, { execPath: updatedBin })).toBe(
      join(harnessHome, "share", "harness", "adapters", "codex-acp.mjs"),
    );
    expect(
      resolveSeccompApplyPath({}, { execPath: updatedBin, platform: "linux", arch: "x64" }),
    ).toBe(join(harnessHome, "share", "harness", "vendor", "seccomp", "x64", "apply-seccomp"));

    // A second self-update resolves through the existing symlink without creating a self-loop.
    const secondShare = preserveShareDir(harnessHome, updatedBin, {});
    expect(secondShare).toBe(origShare);
    expect(realpathSync(join(harnessHome, "share", "harness"))).toBe(origShare);
  });

  test("does not overwrite a real share directory in harness home", () => {
    const prefix = realpathSync(tempDir("pkg-prefix2"));
    const harnessHome = realpathSync(tempDir("pkg-home2"));
    const oldBin = join(prefix, "bin", "harness");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    mkdirSync(join(prefix, "share", "harness", "ui"), { recursive: true });
    writeFileSync(oldBin, "");
    writeFileSync(join(prefix, "share", "harness", "ui", "index.html"), "<!doctype html>");
    const realShare = join(harnessHome, "share", "harness");
    mkdirSync(realShare, { recursive: true });

    preserveShareDir(harnessHome, oldBin, {});
    expect(lstatSync(realShare).isSymbolicLink()).toBe(false);
  });
});
