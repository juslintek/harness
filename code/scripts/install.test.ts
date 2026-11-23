import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeSrtSettings } from "../src/server/features/guard/api";
import { hostTarget, packageDistribution } from "./build";

const INSTALL_SH = resolve(import.meta.dir, "../../scripts/install.sh");
const dirs: string[] = [];
let distDir = "";
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl = "";

function scratch(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function makeZigArchive(outDir: string): void {
  const stage = scratch("harness-zig-stage-");
  mkdirSync(join(stage, "ui"), { recursive: true });
  writeFileSync(join(stage, "harness"), "#!/bin/sh\necho zig-stub\n");
  writeFileSync(join(stage, "harness-hook"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(stage, "harness"), 0o755);
  chmodSync(join(stage, "harness-hook"), 0o755);
  writeFileSync(join(stage, "ui", "index.html"), "<!doctype html><title>zig-ui</title>");
  const name = `harness-zig-${hostTarget()}.tar.gz`;
  const archive = join(outDir, name);
  const tar = Bun.spawnSync(["tar", "-C", stage, "-czf", archive, "harness", "harness-hook", "ui"]);
  expect(tar.exitCode).toBe(0);
  const sha = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(`${archive}.sha256`, `${sha}  ${name}\n`);
}

async function runCmd(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

beforeAll(async () => {
  distDir = scratch("harness-inst-dist-");
  const ui = scratch("harness-inst-ui-");
  writeFileSync(join(ui, "index.html"), '<!doctype html><div id="inst-ui-ok">ok</div>');
  await packageDistribution({ target: hostTarget(), out: distDir, uiDist: ui, version: "8.8.8" });
  makeZigArchive(distDir);
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const file = Bun.file(join(distDir, new URL(req.url).pathname.slice(1)));
      return file
        .exists()
        .then((ok) => (ok ? new Response(file) : new Response("nope", { status: 404 })));
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
}, 120_000);

afterAll(() => {
  server?.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function installSandboxFixture(): Promise<{
  bin: string;
  tree: string;
  settingsPath: string;
}> {
  const work = scratch("harness-inst-acp-");
  const inst = await runCmd(["sh", INSTALL_SH], work, {
    PATH: process.env.PATH ?? "",
    HOME: work,
    HARNESS_BASE_URL: baseUrl,
    HARNESS_INSTALL_DIR: join(work, "bin"),
  });
  expect(inst.code).toBe(0);
  const hHome = join(work, "hhome");
  const tree = join(work, "tree");
  const runDir = join(hHome, "runs", "r1");
  mkdirSync(tree, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const settingsPath = await writeSrtSettings({
    runDir,
    worktree: tree,
    gitCommonDir: null,
    harnessHome: hHome,
    agentStateWrite: [],
    agentEgress: [],
    preset: "offline",
    weakerNetworkIsolation: false,
    codexHome: null,
  });
  return { bin: join(work, "bin", "harness"), tree, settingsPath };
}

test("install.sh canonicalizes relative and spaced dirs even with CDPATH set", async () => {
  const work = scratch("harness-inst-rel-");
  const res = await runCmd(["sh", INSTALL_SH], work, {
    PATH: process.env.PATH ?? "",
    HOME: work,
    CDPATH: ".",
    HARNESS_BASE_URL: baseUrl,
    HARNESS_INSTALL_DIR: "my bin",
    HARNESS_SHARE_DIR: "my share",
  });
  expect(res.code).toBe(0);
  const absShare = join(work, "my share");
  const absBin = join(work, "my bin", "harness");
  expect(res.out).toContain(`HARNESS_SHARE_DIR="${absShare}" harness serve`);

  const srv = Bun.spawn([absBin, "serve"], {
    cwd: work,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: work,
      HARNESS_HOME: join(work, "hhome"),
      HARNESS_PORT: "0",
      HARNESS_SHARE_DIR: absShare,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = srv.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let seen = "";
    let port = 0;
    while (port === 0) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`server exited early: ${seen}`);
      seen += chunk.value;
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(seen);
      if (match?.[1]) port = Number(match[1]);
    }
    const html = await (await fetch(`http://localhost:${port}/`)).text();
    expect(html).toContain("inst-ui-ok");
  } finally {
    srv.kill("SIGTERM");
    await srv.exited;
  }
}, 30_000);

test("install.sh supports HARNESS_BACKEND=zig with harness-hook and ui assets", async () => {
  const work = scratch("harness-inst-zig-");
  const res = await runCmd(["sh", INSTALL_SH], work, {
    PATH: process.env.PATH ?? "",
    HOME: work,
    HARNESS_BASE_URL: baseUrl,
    HARNESS_BACKEND: "zig",
    HARNESS_INSTALL_DIR: join(work, "bin"),
  });
  expect(res.code).toBe(0);
  const run = await runCmd([join(work, "bin", "harness")], work, { PATH: "/usr/bin:/bin" });
  expect(run).toMatchObject({ code: 0, out: "zig-stub\n" });
  expect(readFileSync(join(work, "share", "harness", "ui", "index.html"), "utf8")).toContain(
    "zig-ui",
  );
}, 30_000);

test("installed binary rejects mixed srt -c/argv and exits 143 on SIGTERM", async () => {
  const { bin, tree, settingsPath } = await installSandboxFixture();
  const badArgs = await runCmd([bin, "srt", "-s", settingsPath, "-c", "echo hi", "extra"], tree, {
    PATH: "/usr/bin:/bin",
    HOME: homedir(),
  });
  expect(badArgs.code).toBe(1);
  expect(badArgs.err).toContain("cannot be combined");

  const sleeper = Bun.spawn([bin, "srt", "-s", settingsPath, "--", "/bin/sleep", "30"], {
    cwd: tree,
    env: { PATH: "/usr/bin:/bin", HOME: homedir() },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await Bun.sleep(600);
  sleeper.kill("SIGTERM");
  expect(await sleeper.exited).toBe(143);
}, 30_000);

test("installed binary runs ACP JSON-RPC initialize inside srt without Node or Bun", async () => {
  const { bin, tree, settingsPath } = await installSandboxFixture();
  const initReq = `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "t", version: "1" } },
  })}\n`;
  const acp = Bun.spawn([bin, "srt", "-s", settingsPath, "--", bin, "acp-adapter", "claude"], {
    cwd: tree,
    env: { PATH: "/usr/bin:/bin", HOME: homedir() },
    stdin: new Blob([initReq]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [acpOut, acpCode] = await Promise.all([new Response(acp.stdout).text(), acp.exited]);
  expect(acpCode).toBe(0);
  expect(acpOut).toContain('"@agentclientprotocol/claude-agent-acp"');
}, 30_000);
