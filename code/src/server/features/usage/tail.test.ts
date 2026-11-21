import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { appendEvent } from "../logs/api";
import {
  probeQuota,
  recordUsage,
  startTailers,
  type TailSource,
  tailOnce,
  usageSummary,
} from "./api";

let dir: string;
let db: Database;
let claudeFile: string;
let codexFile: string;
let sources: TailSource[];

const SESSION = "11111111-2222-4333-8444-555555555555";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-usage-"));
  db = openDb(join(dir, "t.db"));
  migrate(db, migrations);
  mkdirSync(join(dir, "claude", "proj"), { recursive: true });
  mkdirSync(join(dir, "codex", "2026", "11", "02"), { recursive: true });
  claudeFile = join(dir, "claude", "proj", `${SESSION}.jsonl`);
  codexFile = join(
    dir,
    "codex",
    "2026",
    "11",
    "02",
    `rollout-2026-11-02T01-00-00-${SESSION}.jsonl`,
  );
  sources = [
    { name: "claude", glob: "*/*.jsonl", root: join(dir, "claude") },
    { name: "codex", glob: "**/rollout-*.jsonl", root: join(dir, "codex") },
  ];
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function claudeLine(id: string): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-11-02T01:00:00.000Z",
    message: {
      id,
      model: "model-a",
      usage: {
        input_tokens: 3,
        output_tokens: 10,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 7,
      },
    },
  })}\n`;
}

// Quota readings expire, so the log lines must be recent for the view to show them.
const minutesAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();

function codexLine(used: number, withInfo = true, timestamp = minutesAgo(2)): string {
  return `${JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: withInfo
        ? {
            last_token_usage: {
              input_tokens: 50,
              cached_input_tokens: 20,
              output_tokens: 9,
              reasoning_output_tokens: 4,
            },
          }
        : null,
      rate_limits: {
        primary: { used_percent: used, window_minutes: 300, resets_at: 4102444800 },
        secondary: { used_percent: 5, window_minutes: 10080, resets_at: 4102448400 },
      },
    },
  })}\n`;
}

function usageEvents(): number {
  return (
    db.query<{ n: number }, []>("SELECT count(*) AS n FROM events WHERE kind='usage'").get()?.n ?? 0
  );
}

test("claude line becomes one usage event, rerun adds none", async () => {
  writeFileSync(claudeFile, claudeLine("msg_1"));
  expect(await tailOnce(db, sources)).toBe(1);
  expect(await tailOnce(db, sources)).toBe(0);
  const row = db
    .query<Record<string, unknown>, []>("SELECT * FROM events WHERE kind='usage'")
    .get();
  expect(row?.gen_ai_request_model).toBe("model-a");
  expect(row?.gen_ai_usage_input_tokens).toBe(3);
  expect(row?.cache_read_tokens).toBe(100);
  expect(row?.cache_write_tokens).toBe(7);
  expect(row?.source).toBe("tail");
  expect(row?.dedupe_key).toBe("claude:msg_1");
});

test("only new bytes are read and a partial last line waits", async () => {
  const second = claudeLine("msg_2");
  writeFileSync(claudeFile, claudeLine("msg_1") + second.slice(0, 20));
  expect(await tailOnce(db, sources)).toBe(1);
  appendFileSync(claudeFile, second.slice(20));
  expect(await tailOnce(db, sources)).toBe(1);
  expect(usageEvents()).toBe(2);
});

test("truncation rescans from zero without duplicating", async () => {
  writeFileSync(claudeFile, claudeLine("msg_1") + claudeLine("msg_2"));
  await tailOnce(db, sources);
  truncateSync(claudeFile, 0);
  writeFileSync(claudeFile, claudeLine("msg_3"));
  expect(await tailOnce(db, sources)).toBe(1);
  expect(usageEvents()).toBe(3);
});

test("codex token_count gives a usage event and quota snapshots", async () => {
  writeFileSync(codexFile, codexLine(42));
  expect(await tailOnce(db, sources)).toBe(1);
  const ev = db.query<Record<string, unknown>, []>("SELECT * FROM events WHERE kind='usage'").get();
  expect(ev?.gen_ai_usage_input_tokens).toBe(30);
  expect(ev?.cache_read_tokens).toBe(20);
  expect(ev?.reasoning_tokens).toBe(4);
  expect(ev?.agent).toBe("codex");
  const snap = db
    .query<{ used_percent: number; resets_at: number }, []>(
      "SELECT used_percent, resets_at FROM quota_snapshots WHERE window='primary'",
    )
    .get();
  expect(snap?.used_percent).toBe(42);
  expect(snap?.resets_at).toBe(4102444800000);
  const view = await probeQuota(db);
  expect(view.find((q) => q.provider === "codex" && q.window === "secondary")?.usedPercent).toBe(5);
  expect(view.find((q) => q.provider === "claude")?.usedPercent).toBeNull();
});

test("unchanged quota is not snapshotted twice, info-less token_count only snapshots", async () => {
  writeFileSync(codexFile, codexLine(42) + codexLine(42) + codexLine(43, false));
  await tailOnce(db, sources);
  const n = db.query<{ n: number }, []>("SELECT count(*) AS n FROM quota_snapshots").get()?.n;
  expect(n).toBe(3);
  expect(usageEvents()).toBe(2);
});

test("sessions already logged through ACP are skipped", async () => {
  appendEvent(db, { kind: "message", conversationId: SESSION, source: "acp" });
  writeFileSync(claudeFile, claudeLine("msg_1"));
  writeFileSync(codexFile, codexLine(1));
  expect(await tailOnce(db, sources)).toBe(0);
});

test("summary keeps a NULL cost as null", () => {
  const since = Date.now() - 1000;
  appendEvent(db, { kind: "usage", agent: "a", runId: "r1", inputTokens: 1, reportedCostUsd: 0.5 });
  appendEvent(db, { kind: "usage", agent: "a", runId: "r2", inputTokens: 1 });
  appendEvent(db, { kind: "usage", agent: "b", runId: "r3", inputTokens: 4, reportedCostUsd: 1 });
  const rows = usageSummary(db, "agent", since);
  const a = rows.find((r) => r.key === "a");
  expect(a?.reportedCostUsd).toBeNull();
  expect(a?.events).toBe(2);
  expect(a?.inputTokens).toBe(2);
  expect(rows.find((r) => r.key === "b")?.reportedCostUsd).toBe(1);
});

test("startTailers picks up new lines on its timer and stops", async () => {
  writeFileSync(claudeFile, claudeLine("msg_t"));
  const stop = startTailers(db, 10, sources);
  await Bun.sleep(100);
  stop();
  expect(usageEvents()).toBe(1);
});

test("an unreadable entry does not stop the sweep", async () => {
  const broken = join(dir, "claude", "proj", "broken.jsonl");
  writeFileSync(broken, claudeLine("msg_bad"));
  chmodSync(broken, 0);
  mkdirSync(join(dir, "claude", "other"));
  writeFileSync(
    join(dir, "claude", "other", "99999999-2222-4333-8444-555555555555.jsonl"),
    claudeLine("msg_ok"),
  );
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  expect(await tailOnce(db, sources)).toBe(1);
  expect(warn).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});

test("quota latest follows the log timestamp, not ingest order", async () => {
  const newer = join(
    dir,
    "codex",
    "2026",
    "11",
    "02",
    `rollout-b-${SESSION.replace("1", "2")}.jsonl`,
  );
  writeFileSync(newer, codexLine(60, true, minutesAgo(1)));
  await tailOnce(db, sources);
  writeFileSync(codexFile, codexLine(10, true, minutesAgo(5)));
  await tailOnce(db, sources);
  const view = await probeQuota(db);
  expect(view.find((q) => q.provider === "codex" && q.window === "primary")?.usedPercent).toBe(60);
});

test("a tail line is skipped for a conversation recorded through recordUsage", async () => {
  recordUsage(db, { id: "run1", agent: "claude", conversationId: SESSION }, [
    {
      model: null,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      reportedCostUsd: null,
      source: "acp",
    },
  ]);
  writeFileSync(claudeFile, claudeLine("msg_1"));
  expect(await tailOnce(db, sources)).toBe(0);
});

test("claude sessions whose cwd is under the harness worktrees dir are skipped", async () => {
  const worktrees = join(dir, "home", "worktrees");
  const inside = JSON.stringify({ cwd: join(worktrees, "run1"), sessionId: SESSION });
  writeFileSync(claudeFile, `${inside}\n${claudeLine("m1")}`);
  const other = join(dir, "claude", "proj", "99999999-2222-4333-8444-555555555555.jsonl");
  writeFileSync(other, `${JSON.stringify({ cwd: join(dir, "elsewhere") })}\n${claudeLine("m2")}`);
  const scoped = sources.map((s) => ({ ...s, excludeCwdUnder: worktrees }));
  expect(await tailOnce(db, scoped)).toBe(1);
  expect(usageEvents()).toBe(1);
});

test("a file larger than the chunk size is read in full, lines cut by a chunk border included", async () => {
  const total = 6000;
  let text = "";
  for (let i = 0; i < total; i++) text += claudeLine(`msg_${i}_${"é".repeat(i % 7)}`);
  writeFileSync(claudeFile, text);
  expect(Buffer.byteLength(text)).toBeGreaterThan(1024 * 1024);
  expect(await tailOnce(db, sources)).toBe(total);
  expect(usageEvents()).toBe(total);
  expect(await tailOnce(db, sources)).toBe(0);
});

test("first sight of a file older than the backfill window stores its size and reads nothing", async () => {
  writeFileSync(claudeFile, claudeLine("msg_old"));
  const old = new Date(Date.now() - 40 * 86_400_000);
  utimesSync(claudeFile, old, old);
  expect(await tailOnce(db, sources)).toBe(0);
  const saved = db
    .query<{ offset: number }, [string]>("SELECT offset FROM tail_offsets WHERE path = ?")
    .get(claudeFile);
  expect(saved?.offset).toBe(Buffer.byteLength(claudeLine("msg_old")));
  appendFileSync(claudeFile, claudeLine("msg_new"));
  utimesSync(claudeFile, old, old);
  expect(await tailOnce(db, sources)).toBe(1);
});

test("an overlapping sweep is skipped instead of running concurrently", async () => {
  writeFileSync(claudeFile, claudeLine("msg_1") + claudeLine("msg_2"));
  const [first, second] = await Promise.all([tailOnce(db, sources), tailOnce(db, sources)]);
  expect(first).toBe(2);
  expect(second).toBe(0);
  expect(usageEvents()).toBe(2);
});
