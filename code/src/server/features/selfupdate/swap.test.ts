import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { build, hostTarget } from "../../../../scripts/build";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import {
  killHomeServer,
  liveServer,
  makeHome,
  makeRepo,
  script,
  tempDir,
  versionAt,
} from "../../test-support/selfupdate-kit";
import { runPipeline } from "./pipeline";
import { spawnServer } from "./proc";
import { createRequest, getRequest, setStatus } from "./requests";
import { snapshotDb } from "./snapshot";
import { resolveCommit } from "./steps";
import { flipSymlink, type SwapDeps, type SwapOptions, swap } from "./swap";

const OLD = "1.0.0-live";
const NEW = "2.0.0-new";
const BUILD_MS = 180_000;
const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
let oldBin = "";
let newBin = "";
const homes: string[] = [];

beforeAll(async () => {
  const dir = tempDir("selfupdate-bins");
  oldBin = await build({ target: hostTarget(), out: join(dir, "old"), version: OLD });
  newBin = await build({ target: hostTarget(), out: join(dir, "new"), version: NEW });
}, BUILD_MS);

afterAll(() => {
  for (const home of homes) killHomeServer(home);
});

// A live old server with one request row already in its db, as the pipeline would find it.
async function setup(): Promise<{
  home: string;
  port: number;
  stopOld: () => Promise<void>;
  pid: number;
  opts: Omit<SwapOptions, "current" | "version">;
  read: () => Database;
  id: string;
}> {
  const { home, db } = makeHome();
  db.close();
  homes.push(home);
  const live = await liveServer(oldBin, home);
  const conn = openDb(join(home, "harness.db"));
  const id = createRequest(conn, { repo: "r", branch: "b", commitSha: "c", createdBy: "u" }).id;
  setStatus(conn, id, "swapping");
  const snapshot = snapshotDb(conn, home, `${id}-swap`);
  createRequest(conn, { repo: "r2", branch: "b", commitSha: "c", createdBy: "after-snapshot" });
  conn.close();
  return {
    home,
    port: live.port,
    pid: live.proc.pid,
    stopOld: async () => {
      live.proc.kill("SIGTERM");
      await live.proc.exited;
    },
    opts: { oldPid: live.proc.pid, previous: oldBin, home, port: live.port, snapshot, request: id },
    read: () => openDb(join(home, "harness.db")),
    id,
  };
}

function statusOf(db: Database, id: string): string | undefined {
  const status = getRequest(db, id)?.status;
  db.close();
  return status;
}

const FAST: SwapDeps = { launch: spawnServer, healthMs: 20_000, oldExitMs: 20_000 };

describe("swap with compiled binaries", () => {
  test("success: the real port reports the new version and the request is done", async () => {
    const s = await setup();
    const current = join(s.home, "bin", "current");
    flipSymlink(current, newBin);
    const running = swap({ ...s.opts, current, version: NEW }, FAST);
    await s.stopOld();
    expect(await running).toBe("done");
    expect(await versionAt(s.port)).toBe(NEW);
    expect(statusOf(s.read(), s.id)).toBe("done");
  }, 60_000);

  test("a broken new binary rolls back to the snapshot and the old version", async () => {
    const s = await setup();
    const broken = script(tempDir("broken"), "harness-broken", "exit 1");
    const current = join(s.home, "bin", "current");
    flipSymlink(current, broken);
    const atPreviousLaunch: string[] = [];
    const deps: SwapDeps = {
      ...FAST,
      launch: (binary, spot) => {
        if (binary === oldBin) atPreviousLaunch.push(sha(join(s.home, "harness.db")));
        return spawnServer(binary, spot);
      },
    };
    const running = swap({ ...s.opts, current, version: NEW }, deps);
    await s.stopOld();
    expect(await running).toBe("rolled_back");
    expect(atPreviousLaunch).toEqual([sha(s.opts.snapshot)]);
    expect(await versionAt(s.port)).toBe(OLD);
    const check = s.read();
    const requests = check.query("SELECT count(*) AS n FROM update_requests").get() as {
      n: number;
    };
    check.close();
    expect(requests.n).toBe(1);
    expect(statusOf(s.read(), s.id)).toBe("rolled_back");
    expect(readFileSync(current, "utf8")).toBe(readFileSync(oldBin, "utf8"));
  }, 60_000);
});

describe("an interrupted swap", () => {
  test("a swap killed while waiting leaves the previous binary, the snapshot and `swapping`", async () => {
    const s = await setup();
    const current = join(s.home, "bin", "current");
    flipSymlink(current, newBin);
    const helper = Bun.spawn(
      [
        newBin,
        "swap",
        "--old-pid",
        `${s.pid}`,
        "--current",
        current,
        "--previous",
        oldBin,
        "--home",
        s.home,
        "--port",
        `${s.port}`,
        "--snapshot",
        s.opts.snapshot,
        "--request",
        s.id,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    await Bun.sleep(1500);
    helper.kill("SIGKILL");
    await helper.exited;
    expect(existsSync(oldBin)).toBe(true);
    expect(existsSync(s.opts.snapshot)).toBe(true);
    expect(statusOf(s.read(), s.id)).toBe("swapping");
    expect(await versionAt(s.port)).toBe(OLD);
  }, 60_000);
});

describe("the full pipeline", () => {
  test("check, build, scratch verify and swap end with the new version on the live port", async () => {
    const repo = await makeRepo(NEW);
    const s = await setup();
    const commitSha = await resolveCommit(repo, "main");
    const pipelineDb = s.read();
    const req = createRequest(pipelineDb, { repo, branch: "main", commitSha, createdBy: "u1" });
    await runPipeline(pipelineDb, req.id, {
      home: s.home,
      port: s.port,
      pid: s.pid,
      liveBinary: oldBin,
      verifyMs: 30_000,
      beginShutdown: () => void s.stopOld(),
      steps: {
        install: ["true"],
        check: ["true"],
        build: (out) => [
          "sh",
          "-c",
          `mkdir -p "${out}" && cp "${newBin}" "${out}/harness" && echo "${out}/harness"`,
        ],
      },
    });
    const deadline = Date.now() + 60_000;
    while (getRequest(pipelineDb, req.id)?.status === "swapping" && Date.now() < deadline)
      await Bun.sleep(300);
    expect(getRequest(pipelineDb, req.id)?.status).toBe("done");
    expect(await versionAt(s.port)).toBe(NEW);
  }, 120_000);
});

describe("service-managed restart", () => {
  test("the launch hook replaces direct spawn", async () => {
    const home = tempDir("selfupdate-svc");
    const db = openDb(join(home, "harness.db"));
    migrate(db, migrations);
    const id = createRequest(db, { repo: "r", branch: "b", commitSha: "c", createdBy: "u" }).id;
    const snapshot = snapshotDb(db, home, id);
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true, version: NEW }) });
    const target = join(home, "target-bin");
    copyFileSync(oldBin, target);
    const current = join(home, "current");
    symlinkSync(target, current);
    const launched: string[] = [];
    const result = await swap(
      {
        oldPid: 2 ** 22 + 1,
        current,
        previous: oldBin,
        home,
        port: server.port as number,
        snapshot,
        request: id,
        version: NEW,
      },
      {
        ...FAST,
        launch: (binary) => {
          launched.push(binary);
          return { exited: new Promise<number>(() => {}), stop: async () => {} };
        },
      },
    );
    server.stop(true);
    expect(result).toBe("done");
    expect(launched).toEqual([realpathSync(target)]);
  }, 30_000);
});
