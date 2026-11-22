import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTmpDir, scrubEnv, wrapCommand, writeSrtSettings } from "./sandbox";
import { baseInput } from "./sandbox-kit";

async function accountLiveSetup(
  harnessHome: string,
  runDir: string,
  worktree: string,
  opts: {
    agentId: string;
    agentStateWrite: string[];
    codexHome: string | null;
    accountHome: string;
  },
) {
  const settings = await writeSrtSettings({
    ...baseInput,
    runDir,
    worktree,
    gitCommonDir: null,
    gitWorktreeDir: null,
    branch: null,
    agentId: opts.agentId,
    harnessHome,
    agentStateWrite: opts.agentStateWrite,
    agentEgress: [],
    preset: "offline",
    weakerNetworkIsolation: false,
    codexHome: opts.codexHome,
    account: { home: opts.accountHome },
  });
  const env = scrubEnv(process.env, {
    TMPDIR: runTmpDir(runDir),
    CLAUDE_CODE_TMPDIR: runTmpDir(runDir),
    ...(opts.codexHome === null ? {} : { CODEX_HOME: opts.codexHome }),
  });
  let lastStderr = "";
  const run = async (cmd: string): Promise<number> => {
    const proc = Bun.spawn(wrapCommand(settings, ["sh", "-c", cmd]), {
      cwd: worktree,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    lastStderr = err;
    return code;
  };
  return { run, stderr: () => lastStderr };
}

test("live srt: non-default claude account isolates home A from sibling homes, symlinks, and config writes", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "srt-acct-claude-")));
  const harnessHome = join(dir, "hh");
  const runDir = join(harnessHome, "runs", "r1");
  const worktree = join(harnessHome, "worktrees", "r1");
  const accounts = join(harnessHome, "accounts");
  const homeA = join(accounts, "a");
  const homeB = join(accounts, "b");
  try {
    for (const d of [runDir, worktree, join(homeA, "hooks"), homeB]) {
      await mkdir(d, { recursive: true });
    }
    await Bun.write(join(homeB, "auth.json"), "secret-b");
    await symlink(join(homeB, "auth.json"), join(homeA, "link-file"));
    await symlink(homeB, join(homeA, "link-dir"));

    const { run, stderr } = await accountLiveSetup(harnessHome, runDir, worktree, {
      agentId: "claude",
      agentStateWrite: ["~/.claude"],
      codexHome: null,
      accountHome: homeA,
    });

    // Can read and write a normal file inside homeA.
    expect(await run(`echo ok > ${homeA}/note.txt && cat ${homeA}/note.txt`)).toBe(0);
    expect(await Bun.file(join(homeA, "note.txt")).text()).toBe("ok\n");

    // Cannot read sibling homeB/auth.json or list accounts/.
    expect(await run(`cat ${homeB}/auth.json`)).not.toBe(0);
    expect(stderr()).toContain("Operation not permitted");
    expect(await run(`ls ${accounts}`)).not.toBe(0);
    expect(stderr()).toContain("Operation not permitted");

    // Cannot write homeA/settings.json or homeA/hooks/evil.sh.
    expect(await run(`echo '{}' > ${homeA}/settings.json`)).not.toBe(0);
    expect(stderr()).toContain("Operation not permitted");
    expect(existsSync(join(homeA, "settings.json"))).toBe(false);
    expect(await run(`echo evil > ${homeA}/hooks/evil.sh`)).not.toBe(0);
    expect(stderr()).toContain("Operation not permitted");
    expect(existsSync(join(homeA, "hooks", "evil.sh"))).toBe(false);

    // Symlinks inside homeA pointing to homeB or homeB/auth.json are unreadable.
    expect(await run(`cat ${homeA}/link-file`)).not.toBe(0);
    expect(stderr()).toContain("Operation not permitted");
    expect(await run(`cat ${homeA}/link-dir/auth.json`)).not.toBe(0);
    expect(stderr()).toContain("Operation not permitted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test("live srt: a sibling account home created after the run starts is unreadable", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "srt-acct-late-")));
  const harnessHome = join(dir, "hh");
  const runDir = join(harnessHome, "runs", "r1");
  const worktree = join(harnessHome, "worktrees", "r1");
  const accounts = join(harnessHome, "accounts");
  const homeA = join(accounts, "a");
  try {
    for (const d of [runDir, worktree, homeA]) await mkdir(d, { recursive: true });
    const { run, stderr } = await accountLiveSetup(harnessHome, runDir, worktree, {
      agentId: "claude",
      agentStateWrite: ["~/.claude"],
      codexHome: null,
      accountHome: homeA,
    });
    const homeC = join(accounts, "c");
    const lateFile = join(homeC, "auth.json");
    const running = run(`sleep 2; cat ${lateFile} && exit 1; exit 0`);
    await Bun.sleep(800);
    await mkdir(homeC, { recursive: true });
    await Bun.write(lateFile, "secret-c");
    expect(await running).toBe(0);
    expect(stderr()).toContain("Operation not permitted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test("live srt: non-default codex run reads its codexHome copy and cannot read any account home", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "srt-acct-codex-")));
  const harnessHome = join(dir, "hh");
  const runDir = join(harnessHome, "runs", "r1");
  const worktree = join(harnessHome, "worktrees", "r1");
  const codexHome = join(runDir, "codex-home");
  const accounts = join(harnessHome, "accounts");
  const homeA = join(accounts, "a");
  const homeB = join(accounts, "b");
  try {
    for (const d of [join(codexHome, "rules"), worktree, homeA, homeB]) {
      await mkdir(d, { recursive: true });
    }
    await Bun.write(join(homeA, "auth.json"), "secret-a");
    await Bun.write(join(homeB, "auth.json"), "secret-b");
    await Bun.write(join(codexHome, "auth.json"), "copied-b");

    const { run, stderr } = await accountLiveSetup(harnessHome, runDir, worktree, {
      agentId: "codex",
      agentStateWrite: [],
      codexHome,
      accountHome: homeB,
    });

    expect(await run(`cat ${codexHome}/auth.json`)).toBe(0);
    expect(await run(`echo bad > ${codexHome}/config.toml`)).not.toBe(0);
    expect(stderr()).toContain("Operation not permitted");
    expect(await run(`echo bad > ${codexHome}/rules/x`)).not.toBe(0);
    expect(stderr()).toContain("Operation not permitted");

    expect(await run(`cat ${homeA}/auth.json`)).not.toBe(0);
    expect(stderr()).toContain("Operation not permitted");
    expect(await run(`cat ${homeB}/auth.json`)).not.toBe(0);
    expect(stderr()).toContain("Operation not permitted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
