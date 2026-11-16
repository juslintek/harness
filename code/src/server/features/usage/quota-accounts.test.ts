import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { recordQuota } from "./api";
import { latestQuota, pruneQuota } from "./quota";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-quota-accounts-"));
  db = openDb(join(dir, "t.db"));
  migrate(db, migrations);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const window = { provider: "claude", window: "five_hour", resetsAt: null, source: "acp" } as const;

function usedBy(accountId: string): number | null | undefined {
  return latestQuota(db, accountId).find((q) => q.window === "five_hour")?.usedPercent;
}

test("two accounts of one provider keep their own readings", () => {
  recordQuota(db, { ...window, accountId: "acct-a", usedPercent: 30 });
  recordQuota(db, { ...window, accountId: "acct-b", usedPercent: 80 });
  expect(usedBy("acct-a")).toBe(30);
  expect(usedBy("acct-b")).toBe(80);
  recordQuota(db, { ...window, accountId: "acct-a", usedPercent: 55 });
  expect(usedBy("acct-a")).toBe(55);
  expect(usedBy("acct-b")).toBe(80);
});

test("an omitted account is the default account of the provider", () => {
  recordQuota(db, { ...window, usedPercent: 12 });
  expect(usedBy("default:claude")).toBe(12);
  expect(
    latestQuota(db).find((q) => q.provider === "claude" && q.usedPercent === 12),
  ).toMatchObject({
    accountId: "default:claude",
  });
});

test("old rows without an account read as the default account", () => {
  db.run(
    "INSERT INTO quota_snapshots (id, provider, window, used_percent, resets_at, source, ts) VALUES ('old', 'claude', 'five_hour', 41, NULL, 'tail', ?)",
    [Date.now()],
  );
  expect(usedBy("default:claude")).toBe(41);
});

test("a reading older than its provider TTL reads as unknown", () => {
  const now = Date.now();
  recordQuota(db, { ...window, accountId: "claude-old", usedPercent: 40, ts: now - 61 * MINUTE });
  recordQuota(db, { ...window, accountId: "claude-new", usedPercent: 40, ts: now - 59 * MINUTE });
  const codex = { provider: "codex", window: "primary", resetsAt: null, source: "probe" } as const;
  recordQuota(db, { ...codex, accountId: "codex-old", usedPercent: 40, ts: now - 11 * MINUTE });
  recordQuota(db, { ...codex, accountId: "codex-new", usedPercent: 40, ts: now - 9 * MINUTE });
  expect(usedBy("claude-old")).toBeNull();
  expect(usedBy("claude-new")).toBe(40);
  const codexUsed = (id: string) =>
    latestQuota(db, id).find((q) => q.window === "primary")?.usedPercent;
  expect(codexUsed("codex-old")).toBeNull();
  expect(codexUsed("codex-new")).toBe(40);
});

test("retention removes snapshots older than 30 days and keeps the rest", () => {
  const now = Date.now();
  recordQuota(db, { ...window, accountId: "acct-a", usedPercent: 1, ts: now - 31 * DAY });
  recordQuota(db, { ...window, accountId: "acct-a", usedPercent: 2, ts: now - 29 * DAY });
  expect(pruneQuota(db, now)).toBe(1);
  const left = db
    .query<{ used_percent: number }, []>("SELECT used_percent FROM quota_snapshots")
    .all();
  expect(left).toEqual([{ used_percent: 2 }]);
});
