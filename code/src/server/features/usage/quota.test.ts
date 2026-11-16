import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { probeQuota, recordQuota } from "./api";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-quota-"));
  db = openDb(join(dir, "t.db"));
  migrate(db, migrations);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("no snapshots: every provider is unknown", async () => {
  const view = await probeQuota(db);
  expect(view.length).toBeGreaterThan(0);
  expect(view.every((q) => q.usedPercent === null && q.source === "unknown")).toBe(true);
});

test("latest snapshot per window wins", async () => {
  const ins = db.query(
    "INSERT INTO quota_snapshots (id, provider, window, used_percent, resets_at, source, ts) VALUES (?, 'codex', 'primary', ?, NULL, 'tail', ?)",
  );
  ins.run("a", 10, Date.now() - 2000);
  ins.run("b", 30, Date.now() - 1000);
  const view = await probeQuota(db);
  const codex = view.filter((q) => q.provider === "codex");
  expect(codex).toHaveLength(1);
  expect(codex[0]?.usedPercent).toBe(30);
});

test("recordQuota stores a percent snapshot visible to probeQuota", async () => {
  recordQuota(db, {
    provider: "claude",
    window: "five_hour",
    usedPercent: 37.5,
    resetsAt: 4102444800000,
    source: "acp",
  });
  const view = await probeQuota(db);
  expect(view.find((q) => q.provider === "claude" && q.window === "five_hour")).toMatchObject({
    usedPercent: 37.5,
    resetsAt: 4102444800000,
    source: "acp",
  });
});

test("a snapshot whose window already reset reads as unknown", async () => {
  recordQuota(db, {
    provider: "codex",
    window: "primary",
    usedPercent: 90,
    resetsAt: Date.now() - 1000,
    source: "tail",
  });
  const view = await probeQuota(db);
  expect(
    view.find((q) => q.provider === "codex" && q.window === "primary")?.usedPercent,
  ).toBeNull();
});
