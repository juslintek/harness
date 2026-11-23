import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { bootApi } from "../../test-support/api-kit";
import { appendEvent } from "../logs/api";
import { recordQuota, recordUsage, type UsageRecord, usageSummary } from "../usage/api";

function seedModelPrice(db: Database): void {
  db.run(
    `INSERT INTO model_registry
       (provider, model_id, name, input_usd_mtok, output_usd_mtok, cache_read_usd_mtok, context_window, tool_call, reasoning, fetched_at)
     VALUES ('anthropic', 'claude-sonnet-4-5', 'Sonnet', 3, 15, 0.3, 200000, 1, 1, ?)`,
    [Date.now()],
  );
}

function seedAccount(db: Database, id: string, runtime = "claude"): void {
  db.run(
    `INSERT OR IGNORE INTO agent_accounts
       (id, runtime, kind, label, home, state, max_concurrent, created_at, updated_at)
     VALUES (?, ?, 'login', ?, '/h', 'active', 2, 1, 1)`,
    [id, runtime, id],
  );
}

const rec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  model: "claude-sonnet-4-5",
  inputTokens: 1_000_000,
  outputTokens: 100_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  reportedCostUsd: null,
  source: "acp",
  ...over,
});

test("usageSummary(by=account) and /api/usage?by=account separate runs by account", async () => {
  const kit = bootApi();
  const admin = await kit.user({ admin: true });
  seedModelPrice(kit.db);
  seedAccount(kit.db, "acct-a");
  seedAccount(kit.db, "acct-b");
  recordUsage(kit.db, { id: "run-a", agent: "claude", accountId: "acct-a" }, [rec()]);
  recordUsage(kit.db, { id: "run-b", agent: "claude", accountId: "acct-b" }, [
    rec({ inputTokens: 2_000_000, outputTokens: 200_000 }),
  ]);

  const rows = usageSummary(kit.db, "account", 0);
  expect(rows.find((r) => r.key === "acct-a")).toMatchObject({
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    reportedCostUsd: null,
  });
  expect(rows.find((r) => r.key === "acct-b")).toMatchObject({
    inputTokens: 2_000_000,
    outputTokens: 200_000,
    reportedCostUsd: null,
  });
  expect((await kit.call(admin, "GET", "/api/usage?by=account")).status).toBe(200);
});

test("GET /api/agents/:id/accounts/:acct/usage requires admin and returns tokens, estimated USD, daily and window totals", async () => {
  const kit = bootApi();
  const admin = await kit.user({ admin: true });
  const plain = await kit.user({ admin: false });
  seedModelPrice(kit.db);
  seedAccount(kit.db, "acct-a");
  seedAccount(kit.db, "acct-b");
  recordUsage(kit.db, { id: "run-a", agent: "claude", accountId: "acct-a" }, [rec()]);
  recordUsage(kit.db, { id: "run-b", agent: "claude", accountId: "acct-b" }, [
    rec({ inputTokens: 2_000_000, outputTokens: 200_000 }),
  ]);
  recordQuota(kit.db, {
    provider: "claude",
    accountId: "acct-a",
    window: "five_hour",
    usedPercent: 40,
    resetsAt: Date.now() + 3_600_000,
    source: "acp",
  });

  expect((await kit.call(plain, "GET", "/api/agents/claude/accounts/acct-a/usage")).status).toBe(
    403,
  );
  expect((await kit.call(admin, "GET", "/api/agents/claude/accounts/missing/usage")).status).toBe(
    404,
  );

  const resA = await kit.call(admin, "GET", "/api/agents/claude/accounts/acct-a/usage");
  expect(resA.status).toBe(200);
  const bodyA = (await resA.json()) as {
    totals: { inputTokens: number; estimatedCostUsd: number; reportedCostUsd: number | null };
    byDay: Array<{ day: string; estimatedCostUsd: number }>;
    windows: Array<{ window: string; estimatedCostUsd: number }>;
  };
  expect(bodyA.totals.inputTokens).toBe(1_000_000);
  expect(bodyA.totals.reportedCostUsd).toBeNull();
  expect(bodyA.totals.estimatedCostUsd).toBeCloseTo(4.5, 4);
  expect(bodyA.byDay).toHaveLength(1);
  expect(bodyA.windows.find((w) => w.window === "five_hour")?.estimatedCostUsd).toBeCloseTo(4.5, 4);

  const resB = await kit.call(admin, "GET", "/api/agents/claude/accounts/acct-b/usage");
  expect(
    ((await resB.json()) as { totals: { estimatedCostUsd: number } }).totals.estimatedCostUsd,
  ).toBeCloseTo(9.0, 4);
});

test("tailer events with no run and legacy NULL account_id rows attribute to default:<agent>", async () => {
  const kit = bootApi();
  const admin = await kit.user({ admin: true });
  seedModelPrice(kit.db);
  seedAccount(kit.db, "default:claude");

  // Tailer event: no runId, no accountId -> COALESCE yields default:claude
  appendEvent(kit.db, {
    kind: "usage",
    agent: "claude",
    model: "claude-sonnet-4-5",
    operation: "chat",
    inputTokens: 500_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    source: "tail",
    dedupeKey: "tail:1",
  });
  // Legacy run event with NULL account_id -> COALESCE yields default:claude
  recordUsage(kit.db, { id: "legacy-run", agent: "claude" }, [
    rec({ inputTokens: 500_000, outputTokens: 0 }),
  ]);

  const rows = usageSummary(kit.db, "account", 0);
  expect(rows.find((r) => r.key === "default:claude")).toMatchObject({
    inputTokens: 1_000_000,
    events: 2,
  });

  const res = await kit.call(admin, "GET", "/api/agents/claude/accounts/default:claude/usage");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    totals: { inputTokens: number; estimatedCostUsd: number; events: number };
  };
  expect(body.totals.inputTokens).toBe(1_000_000);
  expect(body.totals.events).toBe(2);
  expect(body.totals.estimatedCostUsd).toBeCloseTo(3.0, 4);
});
