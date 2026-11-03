import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runTmpDir } from "./sandbox";
import { liveFixture } from "./sandbox-kit";

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
    for (const f of [
      "harness.db",
      "harness.db-wal",
      "secret",
      "secrets.json",
      "runs/other/srt.json",
    ]) {
      expect(await run(`cat ${join(harnessHome, f)}`)).not.toBe(0);
    }
    expect(await run(`cat ${join(runDir, "srt.json")} ${worktree}/a`)).toBe(0);
  } finally {
    if (existsSync(canary)) await rm(canary);
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test("live srt: a commit works, the git pointer, hooks, config and other refs stay read-only", async () => {
  const { dir, repo, gitDir, adminDir, worktree, run, stderr } = await liveFixture();
  const commit = "git -c user.name=t -c user.email=t@t commit -q";
  try {
    expect(await run(`echo y > f && git add f && git status --short && ${commit} -m t`)).toBe(0);
    expect(stderr()).not.toContain("packed-refs.lock");
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

test("live srt: a read-only run cannot write in the worktree or commit", async () => {
  const { dir, repo, worktree, run } = await liveFixture(true);
  const commit = "git -c user.name=t -c user.email=t@t commit -q";
  try {
    expect(await run(`touch ${worktree}/a`)).not.toBe(0);
    expect(existsSync(join(worktree, "a"))).toBe(false);
    expect(await run(`${commit} --allow-empty -m t`)).not.toBe(0);
    const tip = (await Bun.$`git -C ${repo} rev-parse harness/x`.text()).trim();
    expect(tip).toBe((await Bun.$`git -C ${repo} rev-parse main`.text()).trim());
    expect(await run("git log -1 --format=%s && git diff main..harness/x")).toBe(0);
    expect(await run("touch $TMPDIR/x")).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
