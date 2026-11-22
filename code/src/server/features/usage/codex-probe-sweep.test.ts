import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountKind, AccountState } from "../../../shared/accounts";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { FAKE_CODEX_APP_SERVER } from "../../test-support/fake-codex-app-server";
import {
  type CodexProbeOpts,
  probeCandidateCodexAccounts,
  recordQuota,
  startCodexQuotaProbe,
} from "./api";
import type { CodexProbeHandle } from "./codex-probe";
import { latestQuota } from "./quota";

let root: string;
let home: string;
let db: Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harness-codex-sweep-"));
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
): void {
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
}

function writeAuth(id: string, data: Record<string, unknown>): string {
  const accountHome = join(home, "accounts", id);
  mkdirSync(accountHome, { recursive: true });
  writeFileSync(join(accountHome, "auth.json"), JSON.stringify(data));
  return accountHome;
}

function directLaunch(): CodexProbeOpts["launch"] {
  return async (dir, account): Promise<CodexProbeHandle> => {
    const cwd = join(dir, "cwd");
    mkdirSync(cwd, { recursive: true });
    return {
      argv: [process.execPath, FAKE_CODEX_APP_SERVER],
      env: {
        ...process.env,
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

function seedSweepAccounts(now: number): void {
  const resetsAt = Math.floor(now / 1000) + 3600;
  const rows: Array<[string, AccountState, number | null, string?, AccountKind?]> = [
    ["codex-active-none", "active", 11],
    ["codex-unknown-stale", "unknown", 22],
    ["codex-active-fresh", "active", 33],
    ["codex-disabled", "disabled", 44],
    ["codex-pending", "pending", 45],
    ["codex-logged-out", "logged_out", 46],
    ["codex-removing", "removing", 47],
    ["codex-removed", "removed", 48],
    ["codex-apikey", "active", null, "codex", "api_key"],
    ["claude-active", "active", 50, "claude"],
  ];
  for (const [id, state, pct, runtime, kind] of rows) {
    addAccount(id, {
      state,
      ...(runtime ? { runtime } : {}),
      ...(kind ? { kind } : {}),
      home: pct === null ? null : writeAuth(id, { usedPercent: pct, resetsAt }),
    });
  }
}

test("candidate sweep skips non-candidates and fresh readings under 5 minutes", async () => {
  const now = 1_800_000_000_000;
  const probed: string[] = [];
  seedSweepAccounts(now);
  recordQuota(db, snap("codex-active-fresh", "primary", 10, now + 3600_000, now - 4 * 60_000));
  recordQuota(db, snap("codex-unknown-stale", "primary", 10, now + 3600_000, now - 5 * 60_000));

  const baseLaunch = directLaunch();
  const launch: CodexProbeOpts["launch"] = (dir, account) => {
    probed.push(account.id);
    return baseLaunch(dir, account);
  };

  const results = await probeCandidateCodexAccounts(db, { home, launch, now: () => now });
  expect(probed.sort()).toEqual(["codex-active-none", "codex-unknown-stale"]);
  expect([...results.keys()].sort()).toEqual(["codex-active-none", "codex-unknown-stale"]);
  expect(results.get("codex-active-none")?.status).toBe("ok");
  expect(results.get("codex-unknown-stale")?.status).toBe("ok");
});

test("candidate sweep re-probes recent snapshots whose window has already reset", async () => {
  const now = 1_800_000_000_000;
  const nextResetSec = Math.floor(now / 1000) + 3600;
  addAccount("codex-reset", {
    home: writeAuth("codex-reset", { usedPercent: 12, resetsAt: nextResetSec }),
  });
  recordQuota(db, snap("codex-reset", "primary", 88, now - 1_000, now - 60_000));

  const probed: string[] = [];
  const baseLaunch = directLaunch();
  const results = await probeCandidateCodexAccounts(db, {
    home,
    now: () => now,
    launch: (dir, account) => {
      probed.push(account.id);
      return baseLaunch(dir, account);
    },
  });

  expect(probed).toEqual(["codex-reset"]);
  expect(results.get("codex-reset")?.status).toBe("ok");
  expect(latestQuota(db, "codex-reset", now)).toEqual([
    snap("codex-reset", "primary", 12, nextResetSec * 1000, now),
  ]);
});

test("startCodexQuotaProbe skips overlapping ticks and stop awaits in-flight sweep", async () => {
  addAccount("acct-timer", { home: writeAuth("acct-timer", { usedPercent: 12 }) });

  let calls = 0;
  let markEntered!: () => void;
  let releaseProbe!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const baseLaunch = directLaunch();

  const stop = startCodexQuotaProbe(db, {
    home,
    intervalMs: 15,
    minAgeMs: 5 * 60_000,
    launch: async (dir, account) => {
      calls += 1;
      markEntered();
      await new Promise<void>((done) => {
        releaseProbe = done;
      });
      return baseLaunch(dir, account);
    },
  });

  await entered;
  await Bun.sleep(60);
  expect(calls).toBe(1);

  let stopResolved = false;
  const stopping = stop().then(() => {
    stopResolved = true;
  });
  await Bun.sleep(20);
  expect(stopResolved).toBe(false);

  releaseProbe();
  await stopping;
  expect(stopResolved).toBe(true);
});

test("stop() mid-sweep prevents probing remaining candidate accounts", async () => {
  addAccount("acct-first", { home: writeAuth("acct-first", { usedPercent: 10 }) });
  addAccount("acct-second", { home: writeAuth("acct-second", { usedPercent: 20 }) });

  const probed: string[] = [];
  let markFirstEntered!: () => void;
  let releaseFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    markFirstEntered = resolve;
  });
  const baseLaunch = directLaunch();

  const stop = startCodexQuotaProbe(db, {
    home,
    intervalMs: 15,
    minAgeMs: 5 * 60_000,
    launch: async (dir, account) => {
      probed.push(account.id);
      if (probed.length === 1) {
        markFirstEntered();
        await new Promise<void>((done) => {
          releaseFirst = done;
        });
      }
      return baseLaunch(dir, account);
    },
  });

  await firstEntered;
  const stopping = stop();
  releaseFirst();
  await stopping;

  expect(probed).toHaveLength(1);
});
