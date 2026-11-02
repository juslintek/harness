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
  gitWorktreeDir: "/repo/.git/worktrees/r1",
  branch: "harness/r1",
  agentId: "claude",
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
      "/repo/.git/objects",
      "/repo/.git/worktrees/r1",
      "/repo/.git/refs/heads/harness/r1",
      "/repo/.git/refs/heads/harness/r1.lock",
      "/repo/.git/logs/refs/heads/harness/r1",
      join(homedir(), ".claude"),
      `/private/tmp/claude-${uid}`,
      "/private/tmp/claude-*-cwd",
    ]),
  );
  expect(s.filesystem.allowWrite).not.toContain("/repo/.git");
  expect(s.filesystem.denyRead).toContain(join(homedir(), ".codex/auth.json"));
  expect(s.filesystem.denyRead).toContain(join(homedir(), ".gemini/oauth_creds.json"));
  expect(s.filesystem.denyRead).not.toContain(join(homedir(), ".claude/.credentials.json"));
  expect(s.filesystem.denyRead).toEqual(expect.arrayContaining(["/hh/runs", "/hh/worktrees"]));
  expect(s.filesystem.allowRead).toEqual(["/runs/r1", "/wt/r1"]);
  expect(s.network.allowLocalBinding).toBe(true);
  expect(s.network.deniedDomains).toEqual([]);
  expect(s.enableWeakerNetworkIsolation).toBe(true);
  expect(s.network.allowedDomains.filter((d) => d === "github.com")).toHaveLength(1);
  expect(s.network.allowedDomains).toContain("api.anthropic.com");
  expect(s.network.allowedDomains).toContain("registry.npmjs.org");
});

test("git admin pointers and agent code and config dirs are write-denied", () => {
  const denied = buildSrtSettings(baseInput).filesystem.denyWrite;
  expect(denied).toEqual(
    expect.arrayContaining([
      "/repo/.git/hooks",
      "/repo/.git/config",
      "/repo/.git/modules",
      "/repo/.git/worktrees/r1/config.worktree",
      "/repo/.git/worktrees/r1/commondir",
      "/repo/.git/worktrees/r1/gitdir",
      "/wt/r1/.git",
      "/wt/r1/.claude",
      "/wt/r1/.codex",
      join(homedir(), ".codex/rules"),
      join(homedir(), ".claude/shell-snapshots"),
      join(homedir(), ".claude.json"),
      join(homedir(), ".claude/settings.local.json"),
      join(homedir(), ".claude/plugins"),
      join(homedir(), ".claude/skills"),
      join(homedir(), ".claude/commands"),
      join(homedir(), ".gemini/settings.json"),
      join(homedir(), ".gemini/antigravity-cli/settings.json"),
    ]),
  );
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

test("a run may read its own agent's credentials and not the others'", () => {
  const codex = buildSrtSettings({ ...baseInput, agentId: "codex" }).filesystem.denyRead;
  expect(codex).not.toContain(join(homedir(), ".codex/auth.json"));
  expect(codex).toContain(join(homedir(), ".claude/.credentials.json"));
  const agy = buildSrtSettings({ ...baseInput, agentId: "agy" }).filesystem.denyRead;
  expect(agy).not.toContain(join(homedir(), ".gemini/oauth_creds.json"));
  expect(agy).toContain(join(homedir(), ".codex/auth.json"));
});

test("git access without the worktree dir and branch is refused", () => {
  expect(() => buildSrtSettings({ ...baseInput, gitWorktreeDir: null })).toThrow(/run branch/);
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

interface Live {
  dir: string;
  repo: string;
  gitDir: string;
  adminDir: string;
  harnessHome: string;
  runDir: string;
  worktree: string;
  run: (cmd: string) => Promise<number>;
}

async function liveFixture(): Promise<Live> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "srt-live-")));
  const repo = join(dir, "repo");
  const harnessHome = join(dir, "hh");
  const runDir = join(harnessHome, "runs", "mine");
  const worktree = join(harnessHome, "worktrees", "mine");
  for (const d of [
    repo,
    join(harnessHome, "worktrees"),
    join(harnessHome, "runs", "other"),
    runDir,
  ])
    await mkdir(d, { recursive: true });
  await Bun.$`git init -q -b main ${repo}`.quiet();
  await Bun.$`git -C ${repo} -c user.name=t -c user.email=t@t commit -q --allow-empty -m init`.quiet();
  await Bun.$`git -C ${repo} worktree add -q -b harness/x ${worktree}`.quiet();
  for (const f of ["harness.db", "harness.db-wal", "secret", "runs/other/srt.json"]) {
    await Bun.write(join(harnessHome, f), "s");
  }
  const gitDir = join(repo, ".git");
  const adminDir = (await Bun.file(join(worktree, ".git")).text()).trim().slice("gitdir: ".length);
  const settings = await writeSrtSettings({
    ...baseInput,
    runDir,
    worktree,
    gitCommonDir: gitDir,
    gitWorktreeDir: adminDir,
    branch: "harness/x",
    harnessHome,
    agentStateWrite: [],
    agentEgress: [],
    preset: "offline",
    weakerNetworkIsolation: false,
  });
  const env = scrubEnv(process.env, {
    TMPDIR: runTmpDir(runDir),
    CLAUDE_CODE_TMPDIR: runTmpDir(runDir),
  });
  const run = (cmd: string): Promise<number> =>
    Bun.spawn(wrapCommand(settings, ["sh", "-c", cmd]), {
      cwd: worktree,
      env,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
  return { dir, repo, gitDir, adminDir, harnessHome, runDir, worktree, run };
}

test("live srt: l0 holds for worktree, harness home and home", async () => {
  const { dir, harnessHome, runDir, worktree, run } = await liveFixture();
  const canary = join(homedir(), `.harness-canary-${crypto.randomUUID()}`);
  try {
    expect(await run(`touch ${worktree}/a`)).toBe(0);
    expect(existsSync(join(worktree, "a"))).toBe(true);
    expect(await run(`touch ${canary}`)).not.toBe(0);
    expect(existsSync(canary)).toBe(false);
    expect(await run("ls ~/.ssh")).not.toBe(0);
    expect(await run("touch $TMPDIR/x")).toBe(0);
    expect(existsSync(join(runTmpDir(runDir), "x"))).toBe(true);
    expect(await run(`touch ${join(tmpdir(), "harness-sys-tmp-canary")}`)).not.toBe(0);
    for (const f of ["harness.db", "harness.db-wal", "secret", "runs/other/srt.json"]) {
      expect(await run(`cat ${join(harnessHome, f)}`)).not.toBe(0);
    }
    expect(await run(`cat ${join(runDir, "srt.json")} ${worktree}/a`)).toBe(0);
  } finally {
    if (existsSync(canary)) await rm(canary);
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test("live srt: a commit works, the git pointer, hooks, config and other refs stay read-only", async () => {
  const { dir, repo, gitDir, adminDir, worktree, run } = await liveFixture();
  const commit = "git -c user.name=t -c user.email=t@t commit -q";
  try {
    expect(await run(`echo y > f && git add f && git status --short && ${commit} -m t`)).toBe(0);
    expect(await run(`${commit} --allow-empty -m t2`)).toBe(0);
    const tip = (await Bun.$`git -C ${repo} rev-parse harness/x`.text()).trim();
    expect(tip).not.toBe((await Bun.$`git -C ${repo} rev-parse main`.text()).trim());
    expect(await Bun.$`git -C ${repo} fsck --no-dangling 2>&1`.nothrow().text()).toBe("");
    const denied = [
      `echo 'gitdir: ./x' > ${worktree}/.git`,
      `rm ${worktree}/.git`,
      `mv ${worktree}/.git ${worktree}/.git2`,
      `echo x > ${gitDir}/hooks/x`,
      `echo x >> ${gitDir}/config`,
      `echo x > ${adminDir}/config.worktree`,
      `echo ${worktree} > ${adminDir}/commondir`,
      `echo x > ${adminDir}/gitdir`,
      `rm ${adminDir}/commondir`,
      `mv ${adminDir}/gitdir ${adminDir}/gitdir2`,
      `mkdir ${gitDir}/modules`,
      `echo x > ${gitDir}/refs/heads/main`,
      `echo x > ${gitDir}/refs/heads/harness/other`,
      `echo x > ${gitDir}/packed-refs`,
      `echo x > ${gitDir}/worktrees/other-run`,
    ];
    for (const cmd of denied) expect(await run(cmd)).not.toBe(0);
    expect(existsSync(join(gitDir, "hooks", "x"))).toBe(false);
    expect(await run(`echo z > g && git add g && ${commit} -m t3`)).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
