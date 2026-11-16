import type { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fakeCliSpec } from "../../test-support/agents-kit";
import { ensureDefaultAccount, getSpec } from "../agents/api";
import type { RunOutcome } from "./adapter";
import { getRun, startRun, waitForRun } from "./api";
import { prepareAccountCodexHome } from "./codex-home";
import { createProbeLaunch } from "./launch";
import { AccountUnavailable, resolveRunAccount } from "./launch-accounts";
import { cleanup, fakeDeps, fixture, makeDir } from "./manager-kit";

afterAll(cleanup);

const done: RunOutcome = {
  stopReason: "end_turn",
  text: "",
  usage: [],
  error: null,
  sessionId: null,
};

// The lane stub only reports what the run was given; the fake CLI is run by hand with that env.
function deps(
  f: ReturnType<typeof fixture>,
  lane: (ctx: { env: Record<string, string> }) => Promise<RunOutcome>,
) {
  return fakeDeps(f, [], {
    lane,
    resolveSpec: (id) => (id === "claude" || id === "codex" ? fakeCliSpec(id) : null),
  });
}

function addAccount(db: Database, runtime: string, home: string | null, state = "active"): string {
  const id = Bun.randomUUIDv7();
  db.run(
    `INSERT INTO agent_accounts (id, runtime, kind, label, home, state, max_concurrent, created_at, updated_at)
     VALUES (?, ?, 'login', ?, ?, ?, 1, 0, 0)`,
    [id, runtime, `acct-${id}`, home, state],
  );
  return id;
}

const start = (
  db: Database,
  d: ReturnType<typeof deps>,
  repo: string,
  agentId: string,
  accountId?: string,
) =>
  startRun(db, d, {
    agentId,
    repo,
    prompt: "go",
    ...(accountId === undefined ? {} : { accountId }),
  });

test("a claude run on account B gets CLAUDE_CONFIG_DIR, the default account gets none", async () => {
  const f = fixture();
  ensureDefaultAccount(f.db, "claude");
  const home = join(makeDir(), "accounts", "b");
  await mkdir(home, { recursive: true });
  const b = addAccount(f.db, "claude", home);
  const log = join(makeDir(), "fake.log");
  const seen: Record<string, string>[] = [];
  const lane = async (ctx: { env: Record<string, string> }): Promise<RunOutcome> => {
    seen.push(ctx.env);
    const [bin, ...args] = fakeCliSpec("claude").versionArgs;
    Bun.spawnSync([bin as string, ...args], { env: { ...ctx.env, FAKE_BIN_LOG: log } });
    return done;
  };
  const onB = await start(f.db, deps(f, lane), f.repo, "claude", b);
  const onDefault = await start(f.db, deps(f, lane), f.repo, "claude");
  await waitForRun(onB);
  await waitForRun(onDefault);
  expect(seen[0]?.CLAUDE_CONFIG_DIR).toBe(home);
  expect("CLAUDE_CONFIG_DIR" in (seen[1] ?? {})).toBe(false);
  expect(readFileSync(log, "utf8")).toContain(`config=${home}`);
  expect(readFileSync(log, "utf8")).toContain("config=<unset>");
  expect(getRun(f.db, onB)?.accountId).toBe(b);
  expect(getRun(f.db, onDefault)?.accountId).toBe("default:claude");
});

test("a codex run gets a copy of B's auth.json and only B's file takes the refresh", async () => {
  const f = fixture();
  const root = makeDir();
  const homeA = join(root, "accounts", "a");
  const homeB = join(root, "accounts", "b");
  for (const h of [homeA, homeB]) await mkdir(h, { recursive: true });
  writeFileSync(join(homeA, "auth.json"), '{"who":"a"}');
  writeFileSync(join(homeB, "auth.json"), '{"who":"b"}');
  const a = addAccount(f.db, "codex", homeA);
  const b = addAccount(f.db, "codex", homeB);
  let seenHome = "";
  let copied = "";
  const lane = async (ctx: { env: Record<string, string> }): Promise<RunOutcome> => {
    seenHome = ctx.env.CODEX_HOME ?? "";
    const file = join(seenHome, "auth.json");
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    copied = readFileSync(file, "utf8");
    writeFileSync(file, '{"who":"b","refreshed":true}');
    return done;
  };
  const id = await start(f.db, deps(f, lane), f.repo, "codex", b);
  await waitForRun(id);
  expect(seenHome).toEndWith(join("runs", id, "codex-home"));
  expect(copied).toBe('{"who":"b"}');
  expect(readFileSync(join(homeB, "auth.json"), "utf8")).toBe('{"who":"b","refreshed":true}');
  expect(readFileSync(join(homeA, "auth.json"), "utf8")).toBe('{"who":"a"}');
  expect(readdirSync(homeB)).toEqual(["auth.json"]);
  expect(getRun(f.db, id)?.accountId).toBe(b);
  expect(a).not.toBe(b);
});

test("two concurrent runs on one codex account leave a whole auth.json", async () => {
  const f = fixture();
  const home = join(makeDir(), "accounts", "b");
  await mkdir(home, { recursive: true });
  writeFileSync(join(home, "auth.json"), "{}");
  const b = addAccount(f.db, "codex", home);
  const big = (tag: string): string => JSON.stringify({ tag, pad: tag.repeat(200_000) });
  const lane =
    (tag: string) =>
    async (ctx: { env: Record<string, string> }): Promise<RunOutcome> => {
      await Bun.sleep(5);
      writeFileSync(join(ctx.env.CODEX_HOME ?? "", "auth.json"), big(tag));
      return done;
    };
  const ids = await Promise.all([
    start(f.db, deps(f, lane("x")), f.repo, "codex", b),
    start(f.db, deps(f, lane("y")), f.repo, "codex", b),
  ]);
  await Promise.all(ids.map(waitForRun));
  const final = JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as { tag: string };
  expect(["x", "y"]).toContain(final.tag);
  expect(readdirSync(home)).toEqual(["auth.json"]);
});

test("a run that did not change auth.json leaves the account file alone", async () => {
  const f = fixture();
  const home = join(makeDir(), "accounts", "b");
  await mkdir(home, { recursive: true });
  writeFileSync(join(home, "auth.json"), '{"v":1}');
  const b = addAccount(f.db, "codex", home);
  const lane = async (): Promise<RunOutcome> => {
    // Another run refreshed the account's file while this one was running.
    writeFileSync(join(home, "auth.json"), '{"v":2}');
    return done;
  };
  await waitForRun(await start(f.db, deps(f, lane), f.repo, "codex", b));
  expect(readFileSync(join(home, "auth.json"), "utf8")).toBe('{"v":2}');
});

test("an unusable account is refused before a run row exists", async () => {
  const f = fixture();
  const home = join(makeDir(), "accounts", "x");
  const d = deps(f, async () => done);
  const wrongRuntime = addAccount(f.db, "codex", home);
  const removed = addAccount(f.db, "claude", home, "removed");
  const live = addAccount(f.db, "claude", home);
  const before = f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM runs").get()?.n;
  await expect(start(f.db, d, f.repo, "claude", wrongRuntime)).rejects.toBeInstanceOf(
    AccountUnavailable,
  );
  await expect(start(f.db, d, f.repo, "claude", removed)).rejects.toBeInstanceOf(
    AccountUnavailable,
  );
  await expect(start(f.db, d, f.repo, "claude", "nope")).rejects.toBeInstanceOf(AccountUnavailable);
  // The shipped claude spec has accountIsolation off until spike S1 is done.
  const real = fakeDeps(f, [], { resolveSpec: () => getSpec("claude") });
  await expect(start(f.db, real, f.repo, "claude", live)).rejects.toBeInstanceOf(
    AccountUnavailable,
  );
  expect(f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM runs").get()?.n).toBe(before);
  expect(existsSync(home)).toBe(false);
});

test("a probe launch on a codex account copies that account's auth.json too", async () => {
  const f = fixture();
  const home = join(makeDir(), "accounts", "b");
  await mkdir(home, { recursive: true });
  writeFileSync(join(home, "auth.json"), '{"who":"b"}');
  const id = addAccount(f.db, "codex", home);
  const account = resolveRunAccount(f.db, fakeCliSpec("codex"), id);
  const probe = await createProbeLaunch(
    deps(f, async () => done),
    fakeCliSpec("codex"),
    join(makeDir(), "probe"),
    account,
  );
  const file = join(probe.env.CODEX_HOME ?? "", "auth.json");
  expect(lstatSync(file).isSymbolicLink()).toBe(false);
  expect(readFileSync(file, "utf8")).toBe('{"who":"b"}');
  expect(probe.finish).not.toBeNull();
});

test("a run that swaps auth.json for a FIFO cannot hang the write-back, and an oversized account file is refused", async () => {
  const root = makeDir();
  const home = join(root, "accounts", "b");
  await mkdir(home, { recursive: true });
  writeFileSync(join(home, "auth.json"), '{"v":1}');
  const { home: runHome, finish } = await prepareAccountCodexHome(join(root, "run"), "", home);
  rmSync(join(runHome, "auth.json"));
  expect(Bun.spawnSync(["mkfifo", join(runHome, "auth.json")]).exitCode).toBe(0);
  await finish();
  expect(readFileSync(join(home, "auth.json"), "utf8")).toBe('{"v":1}');
  writeFileSync(join(home, "auth.json"), "x".repeat((1 << 20) + 1));
  await expect(prepareAccountCodexHome(join(root, "run2"), "", home)).rejects.toThrow(
    "regular file",
  );
});

test("a refresh from an older login does not replace the credentials that took its place", async () => {
  const f = fixture();
  const home = join(makeDir(), "accounts", "b");
  await mkdir(home, { recursive: true });
  writeFileSync(join(home, "auth.json"), '{"login":"old"}');
  const b = addAccount(f.db, "codex", home);
  const lane = async (ctx: { env: Record<string, string> }): Promise<RunOutcome> => {
    writeFileSync(join(ctx.env.CODEX_HOME ?? "", "auth.json"), '{"login":"old","refreshed":true}');
    // The holder logs in again while the run is still going.
    writeFileSync(join(home, "auth.json"), '{"login":"new"}');
    return done;
  };
  await waitForRun(await start(f.db, deps(f, lane), f.repo, "codex", b));
  expect(readFileSync(join(home, "auth.json"), "utf8")).toBe('{"login":"new"}');
});
