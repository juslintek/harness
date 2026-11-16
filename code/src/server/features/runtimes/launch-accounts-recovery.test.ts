import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fakeCliSpec } from "../../test-support/agents-kit";
import type { RunContext, RunOutcome } from "./adapter";
import { getRun, killRun, recoverRuns, shutdownRuns, startRun, waitForRun } from "./api";
import { prepareAccountCodexHome, withLock, writeBackAccountAuth } from "./codex-home";
import { addAccount, cleanup, fakeDeps, fixture, makeDir } from "./manager-kit";
import { insertRun, markRunning } from "./runs-repo";

afterAll(cleanup);

type Fixture = ReturnType<typeof fixture>;

const done: RunOutcome = {
  stopReason: "end_turn",
  text: "",
  usage: [],
  error: null,
  sessionId: null,
};

async function codexAccount(f: Fixture, name = "b"): Promise<{ home: string; id: string }> {
  const home = join(makeDir(), "accounts", name);
  await mkdir(home, { recursive: true });
  writeFileSync(join(home, "auth.json"), `{"${name}":1}`);
  return { home, id: addAccount(f.db, "codex", home) };
}

function startCodex(
  f: Fixture,
  accountId: string,
  lane: (ctx: RunContext) => Promise<RunOutcome>,
  spec = fakeCliSpec("codex"),
): Promise<string> {
  const deps = fakeDeps(f, [], { lane, resolveSpec: () => spec });
  return startRun(f.db, deps, { agentId: "codex", repo: f.repo, prompt: "go", accountId });
}

// What a token write-back leaves behind in the run dir: nothing that holds the token.
function tokenFiles(runDir: string): string[] {
  const files = [join(runDir, "codex-home", "auth.json"), join(runDir, "codex-auth.base")];
  return files.filter((p) => existsSync(p));
}

test("a codex run's token copy and baseline are gone after it ends", async () => {
  const f = fixture();
  const b = await codexAccount(f);
  let runDir = "";
  const id = await startCodex(f, b.id, async (ctx) => {
    runDir = dirname(ctx.env.CODEX_HOME ?? "");
    expect(tokenFiles(runDir)).toHaveLength(2);
    return done;
  });
  expect(await waitForRun(id)).toMatchObject({ state: "completed" });
  expect(runDir).not.toBe("");
  expect(tokenFiles(runDir)).toEqual([]);
});

test("a kill that arrives while the token is being stored still ends the run as killed", async () => {
  const f = fixture();
  const b = await codexAccount(f);
  let release = (): void => {};
  const id = await startCodex(f, b.id, async () => {
    // Holds the account lock, so the write-back after the lane waits for it.
    void withLock(b.home, () => new Promise<void>((resolve) => (release = resolve)));
    return done;
  });
  while (getRun(f.db, id)?.state !== "running") await Bun.sleep(5);
  await Bun.sleep(20);
  expect(killRun(f.db, id)).toBe(true);
  release();
  expect(await waitForRun(id)).toMatchObject({ state: "killed", reason: "killed_by_user" });
});

test("a failed baseline write removes the copied token", async () => {
  const f = fixture();
  const b = await codexAccount(f);
  const runDir = join(makeDir(), "run");
  // A directory where the baseline file goes makes the write fail.
  await mkdir(join(runDir, "codex-auth.base"), { recursive: true });
  await expect(prepareAccountCodexHome(runDir, "", b.home)).rejects.toThrow();
  expect(existsSync(join(runDir, "codex-home", "auth.json"))).toBe(false);
});

test("shutdown stores the token of a run whose lane never returns", async () => {
  const f = fixture();
  const b = await codexAccount(f);
  let runDir = "";
  const id = await startCodex(f, b.id, (ctx) => {
    runDir = dirname(ctx.env.CODEX_HOME ?? "");
    writeFileSync(join(runDir, "codex-home", "auth.json"), '{"b":"refreshed"}');
    return new Promise(() => {});
  });
  while (runDir === "") await Bun.sleep(5);
  await shutdownRuns(f.db, 10);
  expect(getRun(f.db, id)?.state).toBe("killed");
  expect(readFileSync(join(b.home, "auth.json"), "utf8")).toBe('{"b":"refreshed"}');
  expect(tokenFiles(runDir)).toEqual([]);
});

test("a restart stores a token the run refreshed before the harness died", async () => {
  const f = fixture();
  const runDirs: string[] = [];
  const homes: string[] = [];
  for (const name of ["b", "c"]) {
    const account = await codexAccount(f, name);
    const id = Bun.randomUUIDv7();
    const run = { id, taskId: null, model: null, repo: f.repo, prompt: "p" };
    insertRun(f.db, { ...run, agentId: "codex", accountId: account.id });
    markRunning(f.db, id);
    const runDir = join(f.home, "runs", id);
    const { home } = await prepareAccountCodexHome(runDir, "", account.home);
    writeFileSync(join(home, "auth.json"), `{"${name}":"refreshed"}`);
    runDirs.push(runDir);
    homes.push(account.home);
  }
  const [homeB = "", homeC = ""] = homes;
  // Somebody logged c in again while the harness was down.
  writeFileSync(join(homeC, "auth.json"), '{"c":"new login"}');
  await recoverRuns(f.db, f.home);
  expect(readFileSync(join(homeB, "auth.json"), "utf8")).toBe('{"b":"refreshed"}');
  expect(statSync(join(homeB, "auth.json")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(homeC, "auth.json"), "utf8")).toBe('{"c":"new login"}');
  for (const runDir of runDirs) expect(tokenFiles(runDir)).toEqual([]);
});

test("a launch that fails after the copy-in leaves no token in the run dir", async () => {
  const f = fixture();
  const b = await codexAccount(f);
  // A state path of the whole home is refused when the sandbox profile is written.
  const spec = { ...fakeCliSpec("codex"), stateWrite: ["~"] };
  const id = await startCodex(f, b.id, async () => done, spec);
  expect(await waitForRun(id)).toMatchObject({ state: "failed", reason: "launch_failed" });
  const runDir = join(realpathSync(f.home), "runs", id);
  expect(existsSync(join(runDir, "codex-home"))).toBe(true);
  expect(tokenFiles(runDir)).toEqual([]);
});

test("a run stays unended until its token is stored, so a crash mid-recovery retries it", async () => {
  const f = fixture();
  const account = await codexAccount(f);
  const id = Bun.randomUUIDv7();
  insertRun(f.db, {
    id,
    taskId: null,
    model: null,
    repo: f.repo,
    prompt: "p",
    agentId: "codex",
    accountId: account.id,
  });
  markRunning(f.db, id);
  const { home } = await prepareAccountCodexHome(join(f.home, "runs", id), "", account.home);
  writeFileSync(join(home, "auth.json"), '{"b":"refreshed"}');
  let release = (): void => {};
  void withLock(account.home, () => new Promise<void>((resolve) => (release = resolve)));
  const recovering = recoverRuns(f.db, f.home);
  await Bun.sleep(30);
  expect(getRun(f.db, id)?.state).toBe("running");
  release();
  await recovering;
  expect(getRun(f.db, id)?.state).toBe("failed");
  expect(readFileSync(join(account.home, "auth.json"), "utf8")).toBe('{"b":"refreshed"}');
});

test("a write-back that cannot persist keeps the refreshed token for a retry", async () => {
  const f = fixture();
  const b = await codexAccount(f);
  const runDir = join(makeDir(), "run");
  const { home } = await prepareAccountCodexHome(runDir, "", b.home);
  writeFileSync(join(home, "auth.json"), '{"b":"refreshed"}');
  await chmod(b.home, 0o500);
  try {
    await expect(writeBackAccountAuth(runDir, b.home)).rejects.toThrow();
  } finally {
    await chmod(b.home, 0o700);
  }
  expect(tokenFiles(runDir)).toHaveLength(2);
  await writeBackAccountAuth(runDir, b.home);
  expect(readFileSync(join(b.home, "auth.json"), "utf8")).toBe('{"b":"refreshed"}');
  expect(tokenFiles(runDir)).toEqual([]);
});

test("a token that could not be stored when the run ended is stored by the next restart", async () => {
  const f = fixture();
  const b = await codexAccount(f);
  let runDir = "";
  const id = await startCodex(f, b.id, async (ctx) => {
    runDir = dirname(ctx.env.CODEX_HOME ?? "");
    writeFileSync(join(runDir, "codex-home", "auth.json"), '{"b":"refreshed"}');
    // A read-only account dir fails the temp file write, as a full disk would.
    chmodSync(b.home, 0o500);
    return done;
  });
  try {
    expect(await waitForRun(id)).toMatchObject({ state: "completed" });
    expect(readFileSync(join(b.home, "auth.json"), "utf8")).toBe('{"b":1}');
    expect(tokenFiles(runDir)).toHaveLength(2);
  } finally {
    chmodSync(b.home, 0o700);
  }
  await recoverRuns(f.db, f.home);
  expect(readFileSync(join(b.home, "auth.json"), "utf8")).toBe('{"b":"refreshed"}');
  expect(tokenFiles(runDir)).toEqual([]);
});
