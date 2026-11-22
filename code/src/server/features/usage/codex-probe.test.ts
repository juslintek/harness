import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountKind, AccountState } from "../../../shared/accounts";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { FAKE_CODEX_APP_SERVER } from "../../test-support/fake-codex-app-server";
import { getAccount, markAccountExhausted } from "../agents/api";
import { type CodexProbeOpts, onQuotaRecorded, probeAccountQuota } from "./api";
import type { CodexProbeHandle } from "./codex-probe";
import { latestQuota } from "./quota";

let root: string;
let home: string;
let db: Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harness-codex-probe-"));
  home = join(root, "harness-home");
  mkdirSync(home, { recursive: true });
  db = openDb(join(root, "t.db"));
  migrate(db, migrations);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function addAccount(
  id: string,
  opts: {
    runtime?: string;
    kind?: AccountKind;
    state?: AccountState;
    home?: string | null;
  } = {},
): string {
  const now = Date.now();
  db.run(
    `INSERT INTO agent_accounts
       (id, runtime, kind, label, home, state, max_concurrent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      id,
      opts.runtime ?? "codex",
      opts.kind ?? "login",
      id,
      opts.home === undefined ? join(home, "accounts", id) : opts.home,
      opts.state ?? "active",
      now,
      now,
    ],
  );
  return id;
}

function writeAuth(id: string, data: Record<string, unknown>): string {
  const accountHome = join(home, "accounts", id);
  mkdirSync(accountHome, { recursive: true });
  writeFileSync(join(accountHome, "auth.json"), JSON.stringify(data));
  return accountHome;
}

function directLaunch(extraEnv: Record<string, string> = {}): CodexProbeOpts["launch"] {
  return async (dir, account): Promise<CodexProbeHandle> => {
    const cwd = join(dir, "cwd");
    mkdirSync(cwd, { recursive: true });
    return {
      argv: [process.execPath, FAKE_CODEX_APP_SERVER],
      env: {
        ...process.env,
        ...extraEnv,
        ...(account.home ? { CODEX_HOME: account.home } : {}),
      } as Record<string, string>,
      cwd,
      finish: null,
    };
  };
}

const snap = (
  accountId: string,
  window: string,
  usedPercent: number,
  resetsAt: number,
  ts: number,
) => ({
  provider: "codex",
  accountId,
  window,
  usedPercent,
  resetsAt,
  source: "codex_probe",
  ts,
});

test("probing two codex accounts stores distinct snapshots keyed by accountId with ms resetsAt", async () => {
  const resetA = 1_800_000_000;
  const resetB = 1_800_003_600;
  addAccount("acct-a", {
    home: writeAuth("acct-a", { account: "a@example.test", usedPercent: 22, resetsAt: resetA }),
    state: "unknown",
  });
  addAccount("acct-b", {
    home: writeAuth("acct-b", {
      account: "b@example.test",
      usedPercent: 78,
      secondaryUsedPercent: 41,
      resetsAt: resetB,
    }),
  });

  const now = 1_799_999_000_000;
  const opts: CodexProbeOpts = { home, launch: directLaunch(), now: () => now };
  expect((await probeAccountQuota(db, "acct-a", opts)).status).toBe("ok");
  expect((await probeAccountQuota(db, "acct-b", opts)).status).toBe("ok");

  expect(latestQuota(db, "acct-a", now)).toEqual([
    snap("acct-a", "primary", 22, resetA * 1000, now),
  ]);
  expect(latestQuota(db, "acct-b", now)).toEqual([
    snap("acct-b", "primary", 78, resetB * 1000, now),
    snap("acct-b", "secondary", 41, resetB * 1000, now),
  ]);
  expect(getAccount(db, "acct-a")).toMatchObject({ state: "active", lastProbeAt: now });
  expect(getAccount(db, "acct-b")).toMatchObject({ state: "active", lastProbeAt: now });
});

test("malformed and rpc_error replies return probe_failed without throwing and leave active state intact", async () => {
  addAccount("acct-bad", { home: writeAuth("acct-bad", { mode: "malformed" }) });
  addAccount("acct-rpc", { home: writeAuth("acct-rpc", { mode: "rpc_error" }) });

  expect((await probeAccountQuota(db, "acct-bad", { home, launch: directLaunch() })).status).toBe(
    "probe_failed",
  );
  expect((await probeAccountQuota(db, "acct-rpc", { home, launch: directLaunch() })).status).toBe(
    "probe_failed",
  );
  expect(getAccount(db, "acct-bad")?.state).toBe("active");
  expect(getAccount(db, "acct-rpc")?.state).toBe("active");
});

test("timeout returns probe_failed without throwing and terminates child process", async () => {
  const pidFile = join(root, "hang.pid");
  addAccount("acct-hang", { home: writeAuth("acct-hang", { mode: "hang" }) });

  const res = await probeAccountQuota(db, "acct-hang", {
    home,
    launch: directLaunch({ FAKE_CODEX_PIDFILE: pidFile }),
    timeoutMs: 150,
  });

  expect(res).toEqual({ status: "probe_failed", error: "timeout" });
  expect(getAccount(db, "acct-hang")?.state).toBe("active");
  expect(existsSync(pidFile)).toBe(true);
  const pid = Number(readFileSync(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});

test("logged_out reply updates account state to logged_out without throwing", async () => {
  addAccount("acct-out", { home: writeAuth("acct-out", { mode: "logged_out" }) });
  const now = 1_800_000_123_000;
  const res = await probeAccountQuota(db, "acct-out", {
    home,
    launch: directLaunch(),
    now: () => now,
  });

  expect(res.status).toBe("logged_out");
  expect(getAccount(db, "acct-out")).toMatchObject({ state: "logged_out", lastProbeAt: now });
});

test("fresh <100% probe clears exhaustion while 100% sets exhaustedUntil and notifies onQuotaRecorded", async () => {
  const now = 1_800_000_000_000;
  const resetFutureSec = 1_800_005_000;
  addAccount("acct-clear", {
    home: writeAuth("acct-clear", { usedPercent: 15, resetsAt: resetFutureSec }),
  });
  addAccount("acct-full", {
    home: writeAuth("acct-full", { usedPercent: 100, resetsAt: resetFutureSec }),
  });
  markAccountExhausted(db, "acct-clear", now + 60_000);
  expect(getAccount(db, "acct-clear")?.exhaustedUntil).toBe(now + 60_000);

  const recorded: Array<{ accountId?: string | undefined; usedPercent: number | null }> = [];
  const off = onQuotaRecorded((q) => recorded.push(q));
  try {
    const opts: CodexProbeOpts = { home, launch: directLaunch(), now: () => now };
    expect((await probeAccountQuota(db, "acct-clear", opts)).status).toBe("ok");
    expect(getAccount(db, "acct-clear")?.exhaustedUntil).toBeNull();
    expect((await probeAccountQuota(db, "acct-full", opts)).status).toBe("ok");
    expect(getAccount(db, "acct-full")?.exhaustedUntil).toBe(resetFutureSec * 1000);
    expect(recorded).toContainEqual(
      expect.objectContaining({ accountId: "acct-full", usedPercent: 100 }),
    );
  } finally {
    off();
  }
});

test("account disabled while probeAccountQuota is in flight stays disabled with no snapshot written", async () => {
  addAccount("acct-disabling", {
    home: writeAuth("acct-disabling", { usedPercent: 45, resetsAt: 1_800_005_000 }),
  });
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const baseLaunch = directLaunch();
  const now = 1_800_000_000_000;

  const probing = probeAccountQuota(db, "acct-disabling", {
    home,
    now: () => now,
    launch: async (dir, account) => {
      markEntered();
      await gate;
      return baseLaunch(dir, account);
    },
  });

  await entered;
  db.run("UPDATE agent_accounts SET state = 'disabled' WHERE id = ?", ["acct-disabling"]);
  release();
  const res = await probing;

  expect(res.status).toBe("ok");
  expect(getAccount(db, "acct-disabling")?.state).toBe("disabled");
  expect(latestQuota(db, "acct-disabling", now)).toEqual([]);
});
