import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { build, hostTarget } from "../../../../scripts/build";
import { openDb } from "../../db/db";
import { makeHome, script, tempDir } from "../../test-support/selfupdate-kit";
import { verifyOnScratch } from "./scratch";
import { snapshotDb } from "./snapshot";

const VERSION = "3.0.0-verify";
let binary = "";

beforeAll(async () => {
  binary = await build({
    target: hostTarget(),
    out: join(tempDir("scratch-bin"), "new"),
    version: VERSION,
  });
}, 180_000);

const verify = (home: string, snapshot: string, bin = binary): Promise<void> =>
  verifyOnScratch({
    binary: bin,
    snapshot,
    scratchHome: join(home, "scratch"),
    version: VERSION,
    timeoutMs: 15_000,
  });

// The format reapRuns compares against: boot time and the leader's start time.
function identityOf(pid: number): string {
  const text = (...argv: string[]): string => Bun.spawnSync(argv).stdout.toString().trim();
  return `${text("sysctl", "-n", "kern.boottime")}|${text("ps", "-o", "lstart=", "-p", `${pid}`)}`;
}

const sleepers: Bun.Subprocess[] = [];
afterAll(() => {
  for (const proc of sleepers) process.kill(-proc.pid, "SIGKILL");
});

test("verifying never touches the agent runs listed in the copied db", async () => {
  const { home, db } = makeHome();
  // The trailing `srt` keeps the group in the shape reapRuns recognises as an agent run.
  const agent = Bun.spawn(["sh", "-c", "sleep 300; : srt"], {
    detached: true,
    stdout: "ignore",
    stderr: "ignore",
  });
  sleepers.push(agent);
  db.query(
    "INSERT INTO runs (id, agent_id, repo, prompt, state, created_at, pid, pid_identity) VALUES ('r1', 'a', '/r', 'p', 'running', 1, ?, ?)",
  ).run(agent.pid, identityOf(agent.pid));
  const snapshot = snapshotDb(db, home, "verify");
  await verify(home, snapshot);
  expect(agent.killed).toBe(false);
  expect(agent.exitCode).toBeNull();
  expect(() => process.kill(agent.pid, 0)).not.toThrow();
  const state = openDb(snapshot)
    .query<{ state: string }, []>("SELECT state FROM runs WHERE id = 'r1'")
    .get();
  expect(state?.state).toBe("running");
}, 60_000);

test("a binary whose migrations cannot run fails the verify", async () => {
  const { home, db } = makeHome();
  db.run("PRAGMA user_version = 9999");
  await expect(verify(home, snapshotDb(db, home, "future"))).rejects.toThrow();
}, 60_000);

test("a chatty binary does not stall the verify", async () => {
  const { home, db } = makeHome();
  const chatty = script(
    tempDir("chatty"),
    "harness-chatty",
    'echo "harness listening on http://127.0.0.1:1"; head -c 300000 /dev/zero >&2; sleep 30',
  );
  // The fake never serves health, so the verify must fail on the health wait, not hang on a full pipe.
  await expect(verify(home, snapshotDb(db, home, "chatty"), chatty)).rejects.toThrow(
    /no healthy|exited/,
  );
}, 60_000);
