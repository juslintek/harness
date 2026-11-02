import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSrtSettings,
  runTmpDir,
  type SandboxInput,
  scrubEnv,
  wrapCommand,
  writeSrtSettings,
} from "./sandbox";

const baseInput: SandboxInput = {
  runDir: "/runs/r1",
  worktree: "/wt/r1",
  gitCommonDir: "/repo/.git",
  harnessHome: "/hh",
  agentStateWrite: ["~/.claude", "/private/tmp/claude-<uid>", "/private/tmp/claude-*-cwd"],
  agentEgress: ["api.anthropic.com", "github.com"],
  preset: "dev",
  weakerNetworkIsolation: true,
  codexHome: null,
};

test("settings snapshot: paths expanded, domains merged without duplicates", () => {
  const s = buildSrtSettings(baseInput);
  const uid = process.getuid?.();
  expect(s.filesystem.denyRead).toContain(join(homedir(), ".ssh"));
  expect(s.filesystem.denyRead).toContain("/hh/harness.db*");
  expect(s.filesystem.denyRead).toContain("/hh/secret");
  expect(s.filesystem.allowWrite).toEqual(
    expect.arrayContaining([
      "/wt/r1",
      "/repo/.git",
      join(homedir(), ".claude"),
      `/private/tmp/claude-${uid}`,
      "/private/tmp/claude-*-cwd",
    ]),
  );
  expect(s.filesystem.denyWrite).toEqual(
    expect.arrayContaining([
      "/repo/.git/hooks",
      "/repo/.git/config",
      "/wt/r1/.claude",
      "/wt/r1/.codex",
      join(homedir(), ".codex/rules"),
    ]),
  );
  expect(s.network.allowLocalBinding).toBe(true);
  expect(s.network.deniedDomains).toEqual([]);
  expect(s.enableWeakerNetworkIsolation).toBe(true);
  expect(s.network.allowedDomains.filter((d) => d === "github.com")).toHaveLength(1);
  expect(s.network.allowedDomains).toContain("api.anthropic.com");
  expect(s.network.allowedDomains).toContain("registry.npmjs.org");
});

test("presets and missing git dir", () => {
  const off = buildSrtSettings({ ...baseInput, preset: "offline", gitCommonDir: null });
  expect(off.network.allowedDomains).toEqual(["api.anthropic.com", "github.com"]);
  expect(off.filesystem.allowWrite).not.toContain("/repo/.git");
  expect(off.filesystem.denyWrite.some((p) => typeof p === "string" && p.startsWith("/repo"))).toBe(
    false,
  );
  const open = buildSrtSettings({ ...baseInput, preset: "open-web" });
  expect(open.network.allowedDomains).toContain("*");
});

test("scrubEnv keeps the allowlist and drops secrets", () => {
  const out = scrubEnv(
    {
      PATH: "/bin",
      HOME: "/h",
      LC_ALL: "C",
      ANTHROPIC_API_KEY: "k",
      GH_TOKEN: "t",
      AWS_SECRET_ACCESS_KEY: "s",
    },
    { HARNESS_TOKEN: "x" },
  );
  expect(out).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "C", HARNESS_TOKEN: "x" });
});

test("wrapCommand fails when the settings file is missing", () => {
  expect(() => wrapCommand("/nonexistent/srt.json", ["true"])).toThrow(/settings/);
});

test("codex home is writable but its rules and config are not", () => {
  const s = buildSrtSettings({ ...baseInput, codexHome: "/runs/r1/codex-home" });
  expect(s.filesystem.allowWrite).toContain("/runs/r1/codex-home");
  expect(s.filesystem.denyWrite).toEqual(
    expect.arrayContaining(["/runs/r1/codex-home/rules", "/runs/r1/codex-home/config.toml"]),
  );
});

test("unsafe inputs are refused", () => {
  expect(() => buildSrtSettings({ ...baseInput, agentStateWrite: ["~"] })).toThrow(/home/);
  expect(() => buildSrtSettings({ ...baseInput, agentStateWrite: ["/"] })).toThrow(/home/);
  expect(() => buildSrtSettings({ ...baseInput, agentStateWrite: ["relative/dir"] })).toThrow(
    /absolute/,
  );
  expect(() => buildSrtSettings({ ...baseInput, worktree: "wt" })).toThrow(/absolute/);
  expect(() => buildSrtSettings({ ...baseInput, agentStateWrite: ["/hh"] })).toThrow(
    /expose the harness home/,
  );
});

test("a harness home under the system tmp dir is accepted, and runs get their own tmp", () => {
  const home = mkdtempSync(join(tmpdir(), "hh-"));
  try {
    const s = buildSrtSettings({ ...baseInput, harnessHome: home });
    expect(s.filesystem.allowWrite).toContain(runTmpDir("/runs/r1"));
    expect(s.filesystem.allowWrite).not.toContain(tmpdir());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("live srt: l0 holds for worktree, git dir, harness home and home", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "srt-live-")));
  const repo = join(dir, "repo");
  const harnessHome = join(dir, "hh");
  const runDir = join(dir, "run");
  const worktree = join(harnessHome, "wt");
  for (const d of [repo, harnessHome, runDir]) await mkdir(d);
  await Bun.$`git init -q -b main ${repo}`.quiet();
  await Bun.$`git -C ${repo} -c user.name=t -c user.email=t@t commit -q --allow-empty -m init`.quiet();
  await Bun.$`git -C ${repo} worktree add -q -b harness/x ${worktree}`.quiet();
  for (const f of ["harness.db", "harness.db-wal", "secret"]) {
    await Bun.write(join(harnessHome, f), "s");
  }
  const gitDir = join(repo, ".git");
  const canary = join(homedir(), `.harness-canary-${crypto.randomUUID()}`);
  try {
    const settings = await writeSrtSettings({
      ...baseInput,
      runDir,
      worktree,
      gitCommonDir: gitDir,
      harnessHome,
      agentStateWrite: [],
      agentEgress: [],
      preset: "offline",
      weakerNetworkIsolation: false,
    });
    const run = async (cmd: string): Promise<number> => {
      const proc = Bun.spawn(wrapCommand(settings, ["sh", "-c", cmd]), {
        cwd: worktree,
        env: scrubEnv(process.env, {
          TMPDIR: runTmpDir(runDir),
          CLAUDE_CODE_TMPDIR: runTmpDir(runDir),
        }),
        stdout: "pipe",
        stderr: "pipe",
      });
      return proc.exited;
    };
    expect(await run(`touch ${worktree}/a`)).toBe(0);
    expect(existsSync(join(worktree, "a"))).toBe(true);
    expect(await run(`touch ${canary}`)).not.toBe(0);
    expect(existsSync(canary)).toBe(false);
    expect(await run("ls ~/.ssh")).not.toBe(0);
    expect(await run("touch $TMPDIR/x")).toBe(0);
    expect(existsSync(join(runTmpDir(runDir), "x"))).toBe(true);
    expect(await run(`touch ${join(tmpdir(), "harness-sys-tmp-canary")}`)).not.toBe(0);
    for (const f of ["harness.db", "harness.db-wal", "secret"]) {
      expect(await run(`cat ${join(harnessHome, f)}`)).not.toBe(0);
    }
    expect(await run(`echo x > ${gitDir}/hooks/x`)).not.toBe(0);
    expect(existsSync(join(gitDir, "hooks", "x"))).toBe(false);
    expect(await run(`echo x >> ${gitDir}/config`)).not.toBe(0);
    expect(await run("git -c user.name=t -c user.email=t@t commit -q --allow-empty -m t")).toBe(0);
  } finally {
    if (existsSync(canary)) await rm(canary);
    await rm(dir, { recursive: true, force: true });
  }
});
