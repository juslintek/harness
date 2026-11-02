import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { recordUsage, type UsageRecord, usageSummary } from "./api";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-usage-"));
  db = openDb(join(dir, "t.db"));
  migrate(db, migrations);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const rec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  model: "m",
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
  reasoningTokens: 0,
  reportedCostUsd: null,
  source: "acp",
  ...over,
});

test("recordUsage writes one event per record and later turns do not collide", () => {
  recordUsage(db, { id: "run1", agent: "claude" }, [rec(), rec({ reportedCostUsd: 0.25 })]);
  recordUsage(db, { id: "run1", agent: "claude" }, [rec()]);
  const keys = db
    .query<{ dedupe_key: string }, []>("SELECT dedupe_key FROM events ORDER BY rowid")
    .all()
    .map((r) => r.dedupe_key);
  expect(keys).toEqual(["run:run1:0", "run:run1:1", "run:run1:2"]);
  const [row] = usageSummary(db, "run", 0);
  expect(row).toMatchObject({ key: "run1", events: 3, inputTokens: 30, reportedCostUsd: null });
});
