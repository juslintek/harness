import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fakeCliSpec } from "../../test-support/agents-kit";
import type { RunContext, RunOutcome } from "./adapter";
import { getRun, recoverRuns, shutdownRuns, startRun, waitForRun } from "./api";
import { prepareAccountCodexHome } from "./codex-home";
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
  await waitForRun(id);
  expect(tokenFiles(runDir)).toEqual([]);
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
