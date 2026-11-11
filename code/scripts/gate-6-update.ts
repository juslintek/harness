// Gate 6 assertions 7 to 9: the self-update pipeline on a compiled binary. The pipeline runs the
// real `bun run check` and build in a temp clone of this repo; the live binary swaps itself.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/server/db/db";
import { mintRunToken } from "../src/server/features/mcp/api";
import { spawnServer } from "../src/server/features/selfupdate/proc";
import { createRequest, setStatus } from "../src/server/features/selfupdate/requests";
import { verifyOnScratch } from "../src/server/features/selfupdate/scratch";
import { snapshotDb } from "../src/server/features/selfupdate/snapshot";
import { flipSymlink, type SwapDeps, swap } from "../src/server/features/selfupdate/swap";
import {
  killHomeServer,
  liveServer,
  script,
  versionAt,
} from "../src/server/test-support/selfupdate-kit";
import { build, hostTarget } from "./build";
import { signIn, stepUp } from "./gate-5-kit";
import { BUILD_VERSION, type Built } from "./gate-6-deploy";
import { call, type GateLog, sha256, tempDir } from "./gate-6-kit";
import {
  type Clone,
  healthVersion,
  killLive,
  type Live,
  lockPid,
  makeClone,
  setVersion,
  startLive,
  waitRequest,
} from "./gate-6-live";

const CHECK_MS = 30 * 60_000;
const TERMINAL = ["done", "failed", "rolled_back", "denied", "awaiting_approval"];
const GUARD_FILE = "code/src/server/features/guard/gate6-marker.txt";
const BOOT_EXIT = 'if (version.endsWith("-broken")) process.exit(3);\nconst config = loadConfig();';

async function submit(live: Live, repo: string, branch: string): Promise<string> {
  // Queuing needs step-up; a separate session keeps live.cookie plain for the approval checks.
  const cookie = await signIn(live);
  await stepUp(live, cookie);
  const made = await call(live.client, "POST", "/api/selfupdate/requests", cookie, {
    repo,
    branch,
  });
  if (made.status !== 202) throw new Error(`submit failed: ${made.status}`);
  return String(made.json.id);
}

// package.json is a flagged path, so a version bump stops for approval like any flagged change.
async function runApproved(
  live: Live,
  repo: string,
  branch: string,
): ReturnType<typeof waitRequest> {
  const id = await submit(live, repo, branch);
  const held = await waitRequest(live, id, TERMINAL, CHECK_MS);
  if (held.reply.json.status !== "awaiting_approval") return held;
  const cookie = await signIn(live);
  await stepUp(live, cookie);
  const approved = await call(
    live.client,
    "POST",
    `/api/selfupdate/requests/${id}/approve`,
    cookie,
  );
  if (approved.status !== 202) throw new Error(`approve failed: ${approved.status}`);
  const done = await waitRequest(live, id, TERMINAL.slice(0, -1), CHECK_MS);
  return { ...done, statuses: [...held.statuses, ...done.statuses] };
}

function printLog(log: GateLog, label: string, text: unknown): void {
  const body = String(text ?? "");
  log.print(`${label}: ${body.length} chars of pipeline log, tail:\n${body.slice(-1200)}`);
}

// Assertion 7.
async function goodChange(log: GateLog, live: Live, clone: Clone): Promise<void> {
  const before = lockPid(live);
  const branch = clone.branch("good", { "code/package.json": setVersion("6.0.1-good") });
  const seen = await runApproved(live, clone.dir, branch);
  printLog(log, "good change", seen.reply.json.log);
  const version = await healthVersion(live).catch(() => "unreachable");
  log.print(
    `statuses ${seen.statuses.join(">")}, live now ${version}, pid ${before} -> ${lockPid(live)}`,
  );
  log.report.check(
    7,
    seen.statuses.at(-1) === "done" && version === "6.0.1-good" && lockPid(live) !== before,
    `check, build, scratch verify and swap: live port reports ${version}`,
  );
}

// Assertion 8, part one: the pipeline itself refuses a binary that exits at boot.
async function brokenChange(log: GateLog, live: Live, clone: Clone): Promise<void> {
  const before = lockPid(live);
  const branch = clone.branch("broken", {
    "code/package.json": setVersion("6.0.2-broken"),
    "code/src/main.ts": (text) => text.replace("const config = loadConfig();", BOOT_EXIT),
  });
  const seen = await runApproved(live, clone.dir, branch);
  const reason = String(seen.reply.json.reason ?? "");
  printLog(log, "broken change", seen.reply.json.log);
  log.print(`statuses ${seen.statuses.join(">")}, reason: ${reason}`);
  log.report.check(
    8,
    seen.statuses.includes("verifying") &&
      seen.statuses.at(-1) === "failed" &&
      !seen.statuses.includes("swapping") &&
      (await healthVersion(live)) === "6.0.1-good" &&
      lockPid(live) === before,
    "broken change passed check and build, scratch verify refused it before the swap",
  );
}

const STUB_VERSION = "6.0.9-stub";

// Real new binary behind a wrapper: healthy when it is the swap helper or runs on a scratch home,
// exits on any other home.
async function stubBinary(): Promise<string> {
  const real = await build({
    target: hostTarget(),
    out: tempDir("stub-bin"),
    version: STUB_VERSION,
  });
  return script(
    tempDir("stub"),
    "harness-stub",
    `case "$1" in swap) exec "${real}" "$@";; esac\ncase "$HARNESS_HOME" in *-scratch*) exec "${real}" "$@";; esac\nexit 1`,
  );
}

async function rollbackFixture(built: Built): Promise<{
  home: string;
  old: Awaited<ReturnType<typeof liveServer>>;
  id: string;
  snapshot: string;
}> {
  const home = tempDir("rollback");
  const old = await liveServer(built.path, home);
  const db = openDb(join(home, "harness.db"));
  const id = createRequest(db, { repo: "r", branch: "b", commitSha: "c", createdBy: "u" }).id;
  setStatus(db, id, "swapping");
  const snapshot = snapshotDb(db, home, `${id}-swap`);
  createRequest(db, { repo: "r2", branch: "b", commitSha: "c", createdBy: "after-snapshot" });
  db.close();
  return { home, old, id, snapshot };
}

// Assertion 8, part two: only the swap's own rollback can save the old version and its data.
async function rollbackProof(log: GateLog, built: Built): Promise<void> {
  const stub = await stubBinary();
  const { home, old, id, snapshot } = await rollbackFixture(built);
  try {
    await verifyOnScratch({
      binary: stub,
      snapshot,
      scratchHome: join(home, "selfupdate", `${id}-scratch`),
      version: STUB_VERSION,
      timeoutMs: 30_000,
    });
    const atPrevious: string[] = [];
    const deps: SwapDeps = {
      launch: (binary, spot) => {
        if (binary === built.path) atPrevious.push(sha256(join(home, "harness.db")));
        return spawnServer(binary, spot);
      },
      healthMs: 30_000,
      oldExitMs: 30_000,
    };
    const current = join(home, "bin", "current");
    flipSymlink(current, stub);
    const opts = {
      oldPid: old.proc.pid,
      current,
      previous: built.path,
      home,
      port: old.port,
      snapshot,
      request: id,
      version: STUB_VERSION,
    };
    const running = swap(opts, deps);
    old.proc.kill("SIGTERM");
    await old.proc.exited;
    const outcome = await running;
    const version = await versionAt(old.port);
    log.print(`stub swap: ${outcome}, live ${version}, previous launched ${atPrevious.length}x`);
    log.report.check(
      8,
      outcome === "rolled_back" &&
        version === BUILD_VERSION &&
        atPrevious.length === 1 &&
        atPrevious[0] === sha256(snapshot),
      "swap failure after a good scratch verify rolled back: old version on the same port, harness.db equal to the pre-swap snapshot",
    );
  } finally {
    killHomeServer(home);
  }
}

function bearerStatus(live: Live, token: string, id: string): Promise<number> {
  return fetch(`http://127.0.0.1:${live.port}/api/selfupdate/requests/${id}/approve`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      host: new URL(live.origin).host,
      origin: live.origin,
    },
  }).then((res) => res.status);
}

// Assertion 9.
async function guardChange(log: GateLog, live: Live, clone: Clone): Promise<void> {
  const branch = clone.branch("guard", {
    "code/package.json": setVersion("6.0.3-guard"),
    [GUARD_FILE]: () => "scripted change inside the guard slice\n",
  });
  const id = await submit(live, clone.dir, branch);
  const held = await waitRequest(live, id, TERMINAL, 120_000);
  const review = await call(live.client, "GET", `/api/selfupdate/requests/${id}`, live.cookie);
  const flagged = (review.json.flaggedPaths as string[] | undefined) ?? [];
  const built = existsSync(join(live.home, "bin", `harness-${id}`));
  const conn = openDb(join(live.home, "harness.db"));
  const token = mintRunToken(conn, "gate6-run", ["report", "guard_hook"]);
  conn.close();
  const bearer = await bearerStatus(live, token, id);
  const path = `/api/selfupdate/requests/${id}/approve`;
  const plain = await call(live.client, "POST", path, live.cookie);
  await stepUp(live, live.cookie);
  const waiting = (await call(live.client, "GET", `/api/selfupdate/requests/${id}`, live.cookie))
    .json.status;
  const approved = await call(live.client, "POST", path, live.cookie);
  const done = await waitRequest(live, id, ["done", "failed", "rolled_back", "denied"], CHECK_MS);
  const version = await healthVersion(live).catch(() => "unreachable");
  log.print(
    `guard: held at ${held.statuses.join(">")}, flagged ${flagged.join(",")}, built before approval ${built}, bearer ${bearer}, no step-up ${plain.status}, approved ${approved.status}, then ${done.statuses.join(">")}, live ${version}`,
  );
  log.report.check(
    9,
    held.statuses.at(-1) === "awaiting_approval" &&
      waiting === "awaiting_approval" &&
      flagged.includes(GUARD_FILE) &&
      !built &&
      bearer === 401 &&
      plain.status === 403 &&
      approved.status === 202 &&
      done.statuses.at(-1) === "done" &&
      version === "6.0.3-guard",
    "guard-path diff stopped for approval; bearer 401, no step-up 403; proceeded only after step-up",
  );
}

export async function runUpdatePart(log: GateLog, built: Built): Promise<void> {
  const live = await startLive(built.path);
  const clone = makeClone();
  try {
    await goodChange(log, live, clone);
    await brokenChange(log, live, clone);
    await rollbackProof(log, built);
    await guardChange(log, live, clone);
  } finally {
    killLive(live);
  }
}
