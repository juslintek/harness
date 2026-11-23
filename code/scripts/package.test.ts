import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSettings, writeSrtSettings } from "../src/server/features/guard/api";
import { hostTarget, packageDistribution, parseTarget } from "./build";

const VERSION = "9.9.9-pkg";
const BUILD_TIMEOUT_MS = 120_000;
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const created = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(created);
  return created;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function waitPort(proc: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<number> {
  const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let seen = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`binary exited before listening: ${seen}`);
    seen += chunk.value;
    const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(seen);
    if (match?.[1]) return Number(match[1]);
  }
}

async function exec(
  argv: string[],
  opts: { cwd: string; env: Record<string, string>; stdin?: string },
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

function makeFakeUi(root: string): string {
  const uiDist = join(root, "fake-ui");
  mkdirSync(join(uiDist, "assets"), { recursive: true });
  writeFileSync(
    join(uiDist, "index.html"),
    '<!doctype html><html><body><div id="solid-ui-marker">ok</div><script src="/assets/app.js"></script></body></html>',
  );
  writeFileSync(join(uiDist, "assets", "app.js"), 'console.log("packaged-ui");');
  return uiDist;
}

let installedBin = "";
let installedPrefix = "";

beforeAll(async () => {
  const stage = tempDir("harness-pkg-stage-");
  const archive = await packageDistribution({
    target: hostTarget(),
    out: join(stage, "out"),
    uiDist: makeFakeUi(stage),
    version: VERSION,
  });
  const expectedSha = createHash("sha256").update(readFileSync(archive)).digest("hex");
  expect(readFileSync(`${archive}.sha256`, "utf8").trim()).toBe(
    `${expectedSha}  harness-${hostTarget()}.tar.gz`,
  );

  // Extract into an isolated prefix outside the git repo, matching scripts/install.sh.
  const extract = tempDir("harness-pkg-extract-");
  installedPrefix = tempDir("harness-pkg-prefix-");
  expect(Bun.spawnSync(["tar", "-xzf", archive, "-C", extract]).exitCode).toBe(0);
  const binDir = join(installedPrefix, "bin");
  const shareDir = join(installedPrefix, "share", "harness");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(shareDir, { recursive: true });
  installedBin = join(binDir, "harness");
  cpSync(join(extract, "harness"), installedBin);
  cpSync(join(extract, "ui"), join(shareDir, "ui"), { recursive: true });
  cpSync(join(extract, "adapters"), join(shareDir, "adapters"), { recursive: true });
  if (existsSync(join(extract, "vendor"))) {
    cpSync(join(extract, "vendor"), join(shareDir, "vendor"), { recursive: true });
  }
}, BUILD_TIMEOUT_MS);

test("packaged harness serve auto-detects share/harness/ui and serves assets outside the repo", async () => {
  const home = tempDir("harness-pkg-home-");
  const env = { PATH: process.env.PATH ?? "", HARNESS_HOME: home, HARNESS_PORT: "0" };
  expect(await exec([installedBin, "--version"], { cwd: installedPrefix, env })).toMatchObject({
    code: 0,
    out: `${VERSION}\n`,
  });
  const proc = Bun.spawn([installedBin, "serve"], {
    cwd: installedPrefix,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const base = `http://127.0.0.1:${await waitPort(proc)}`;
    const html = await (await fetch(`${base}/_app`)).text();
    expect(html).toContain("solid-ui-marker");
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.status).toBe(200);
    expect(await js.text()).toContain("packaged-ui");
  } finally {
    proc.kill();
    await proc.exited;
  }
}, 30_000);

test("packaged harness guard-hook enforces L1 deny, allow, ask, and fail-closed outside the repo", async () => {
  const work = realpathSync(tempDir("harness-pkg-hook-"));
  const env = {
    PATH: process.env.PATH ?? "",
    HARNESS_SCOPE_ROOT: work,
    HARNESS_DEFAULT_BRANCH: "main",
    HOME: "/home/u",
  };
  const bash = (command: string): string =>
    JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: work });
  expect(
    (
      await exec([installedBin, "guard-hook"], {
        cwd: installedPrefix,
        env,
        stdin: bash("rm -rf ~"),
      })
    ).code,
  ).toBe(2);
  expect(
    (await exec([installedBin, "guard-hook"], { cwd: installedPrefix, env, stdin: bash("ls") }))
      .code,
  ).toBe(0);
  const ask = await exec([installedBin, "guard-hook"], {
    cwd: installedPrefix,
    env,
    stdin: bash("git push origin feat/x"),
  });
  expect(ask.code).toBe(0);
  expect(ask.out).toContain('"permissionDecision":"ask"');
  expect(
    (await exec([installedBin, "guard-hook"], { cwd: installedPrefix, env, stdin: "not json" }))
      .code,
  ).toBe(2);
}, 30_000);

async function makeSrtFixture() {
  const home = realpathSync(tempDir("harness-pkg-srt-home-"));
  const work = realpathSync(tempDir("harness-pkg-srt-work-"));
  const runDir = join(home, "runs", "pkg-test");
  mkdirSync(runDir, { recursive: true });
  const sentinelPath = join(home, "secrets.json");
  writeFileSync(sentinelPath, "SENTINEL_SECRET_VALUE");
  const settingsPath = await writeSrtSettings({
    runDir,
    worktree: work,
    gitCommonDir: null,
    harnessHome: home,
    agentStateWrite: [],
    agentEgress: [],
    preset: "offline",
    weakerNetworkIsolation: false,
    codexHome: null,
  });
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: homedir(),
    HARNESS_SCOPE_ROOT: work,
    HARNESS_DEFAULT_BRANCH: "main",
  };
  return { work, sentinelPath, settingsPath, env };
}

test("packaged harness srt enforces OS sandbox boundaries, runs guard-hook inside srt, and fails closed", async () => {
  const { work, sentinelPath, settingsPath, env } = await makeSrtFixture();
  const ok = await exec(
    [installedBin, "srt", "-s", settingsPath, "--", "/bin/sh", "-c", `touch '${work}/ok'`],
    { cwd: work, env },
  );
  expect(ok.code).toBe(0);
  expect(existsSync(join(work, "ok"))).toBe(true);
  const control = await exec(["/bin/cat", sentinelPath], { cwd: work, env });
  expect(control).toMatchObject({ code: 0, out: "SENTINEL_SECRET_VALUE" });
  const denied = await exec(
    [installedBin, "srt", "-s", settingsPath, "--", "/bin/cat", sentinelPath],
    { cwd: work, env },
  );
  expect(denied.code).not.toBe(0);
  expect(denied.out).not.toContain("SENTINEL_SECRET_VALUE");
  const hookCmd = claudeSettings(installedBin, "guard-hook").hooks.PreToolUse[0]?.hooks[0]?.command;
  expect(hookCmd).toBeDefined();
  const hookDeny = await exec([installedBin, "srt", "-s", settingsPath, "-c", hookCmd as string], {
    cwd: work,
    env,
    stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf ~" }, cwd: work }),
  });
  expect(hookDeny.code).toBe(2);
  const hookAllow = await exec([installedBin, "srt", "-s", settingsPath, "-c", hookCmd as string], {
    cwd: work,
    env,
    stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: work }),
  });
  expect(hookAllow.code).toBe(0);
  const missing = await exec([installedBin, "srt", "--", "/bin/sh", "-c", "echo hi"], {
    cwd: work,
    env,
  });
  expect(missing.code).toBe(1);
}, 60_000);

test("packaged binary ignores .env and bunfig.toml in an untrusted working directory", async () => {
  const untrusted = tempDir("harness-pkg-untrusted-");
  const preload = join(untrusted, "evil.js");
  const marker = join(untrusted, "pwned");
  writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "pwned");`);
  writeFileSync(join(untrusted, "bunfig.toml"), `preload = [${JSON.stringify(preload)}]\n`);
  writeFileSync(join(untrusted, ".env"), "HARNESS_SCOPE_ROOT=/tmp/injected\nHOME=/tmp/injected\n");
  const res = await exec([installedBin, "guard-hook"], {
    cwd: untrusted,
    env: { PATH: process.env.PATH ?? "" },
    stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: untrusted }),
  });
  expect(res.code).toBe(2);
  expect(existsSync(marker)).toBe(false);
}, 30_000);

test("packaged bundled ACP adapters run through the compiled binary without node or bun", async () => {
  const home = tempDir("harness-pkg-acp-home-");
  for (const rt of ["claude", "codex"] as const) {
    const res = await exec([installedBin, "acp-adapter", rt, "--version"], {
      cwd: installedPrefix,
      env: { PATH: "/usr/bin:/bin", HOME: home },
    });
    expect(res.code).toBe(0);
    expect(res.out.trim().length).toBeGreaterThan(0);
  }
}, 30_000);

test(
  "linux-x64 tarball includes ELF binary, ui, adapters, and apply-seccomp",
  async () => {
    const stage = tempDir("harness-pkg-linux-");
    const archive = await packageDistribution({
      target: parseTarget("linux-x64"),
      out: join(stage, "out"),
      uiDist: makeFakeUi(stage),
    });
    const list = Bun.spawnSync(["tar", "-tzf", archive]).stdout.toString();
    expect(list).toContain("harness");
    expect(list).toContain("ui/index.html");
    expect(list).toContain("adapters/claude-agent-acp.mjs");
    expect(list).toContain("adapters/codex-acp.mjs");
    expect(list).toContain("vendor/seccomp/x64/apply-seccomp");
  },
  BUILD_TIMEOUT_MS,
);
