import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { defaultTailSources, type TailSource, tailOnce } from "./api";

let dir: string;
let db: ReturnType<typeof openDb>;
let sources: TailSource[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-tail-"));
  db = openDb(join(dir, "t.db"));
  migrate(db, migrations);
  mkdirSync(join(dir, "claude", "proj"), { recursive: true });
  mkdirSync(join(dir, "codex"), { recursive: true });
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
    message: { id, model: "m", usage: { input_tokens: 3, output_tokens: 10 } },
  })}\n`;
}

function usageEvents(): number {
  return (
    db.query<{ n: number }, []>("SELECT count(*) AS n FROM events WHERE kind='usage'").get()?.n ?? 0
  );
}

test("a backfill collects garbage after every chunk instead of piling it up", async () => {
  let text = "";
  for (let i = 0; i < 30_000; i++) text += claudeLine(`msg_${i}`);
  writeFileSync(join(dir, "claude", "proj", "a.jsonl"), text);
  const chunks = Math.ceil(Buffer.byteLength(text) / (1024 * 1024));
  expect(chunks).toBeGreaterThan(2);
  const gc = spyOn(Bun, "gc");
  try {
    expect(await tailOnce(db, sources)).toBe(30_000);
    expect(gc.mock.calls.length).toBeGreaterThanOrEqual(chunks);
  } finally {
    gc.mockRestore();
  }
});

test("harness worktree sessions are excluded for codex as well, their usage comes from the run", async () => {
  expect(defaultTailSources("/w").map((s) => s.excludeCwdUnder)).toEqual(["/w", "/w"]);
  const worktrees = join(dir, "worktrees");
  const meta = JSON.stringify({ type: "session_meta", payload: { cwd: join(worktrees, "run1") } });
  const token = JSON.stringify({
    timestamp: "2026-11-02T01:00:00.000Z",
    type: "event_msg",
    payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5 } } },
  });
  writeFileSync(join(dir, "codex", "rollout-a.jsonl"), `${meta}\n${token}\n`);
  const scoped = sources.map((s) => ({ ...s, excludeCwdUnder: worktrees }));
  expect(await tailOnce(db, scoped)).toBe(0);
  expect(usageEvents()).toBe(0);
});
