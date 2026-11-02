import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { type TailSource, tailOnce } from "./api";

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

test("a backfill collects garbage after every chunk, later sweeps of a known file do not", async () => {
  let text = "";
  for (let i = 0; i < 30_000; i++) text += claudeLine(`msg_${i}`);
  writeFileSync(join(dir, "claude", "proj", "a.jsonl"), text);
  const chunks = Math.ceil(Buffer.byteLength(text) / (1024 * 1024));
  expect(chunks).toBeGreaterThan(2);
  const gc = spyOn(Bun, "gc");
  try {
    expect(await tailOnce(db, sources)).toBe(30_000);
    expect(usageEvents()).toBe(30_000);
    expect(gc.mock.calls.length).toBeGreaterThanOrEqual(chunks);
    gc.mockClear();
    appendFileSync(join(dir, "claude", "proj", "a.jsonl"), claudeLine("msg_late"));
    expect(await tailOnce(db, sources)).toBe(1);
    expect(gc).not.toHaveBeenCalled();
  } finally {
    gc.mockRestore();
  }
});
