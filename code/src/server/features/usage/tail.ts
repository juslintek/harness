import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { appendEvent } from "../logs/api";
import { type LineContext, type ParsedLine, parseClaudeLine } from "./claude-tail";
import { parseCodexLine } from "./codex-tail";
import { insertSnapshotIfChanged } from "./quota";

export interface TailSource {
  name: "claude" | "codex";
  glob: string;
  root: string;
}

type Parser = (line: string, offset: number, ctx: LineContext) => ParsedLine;

const PARSERS: Record<TailSource["name"], Parser> = {
  claude: parseClaudeLine,
  codex: parseCodexLine,
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function sessionIdOf(file: string): string {
  return basename(file).match(UUID)?.[0] ?? basename(file, ".jsonl");
}

function loggedViaAcp(db: Database, sessionId: string): boolean {
  return (
    db
      .query<{ one: number }, [string]>(
        "SELECT 1 AS one FROM events WHERE gen_ai_conversation_id = ? AND COALESCE(source, '') != 'tail' LIMIT 1",
      )
      .get(sessionId) !== null
  );
}

interface Offset {
  offset: number;
  mtime: number;
}

function storedOffset(db: Database, path: string): Offset | null {
  return db
    .query<Offset, [string]>("SELECT offset, mtime FROM tail_offsets WHERE path = ?")
    .get(path);
}

function saveOffset(db: Database, path: string, offset: number, mtime: number): void {
  db.query(
    "INSERT INTO tail_offsets (path, offset, mtime) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, mtime = excluded.mtime",
  ).run(path, offset, mtime);
}

function applyLine(db: Database, parsed: ParsedLine): number {
  for (const q of parsed.quotas ?? []) insertSnapshotIfChanged(db, q);
  return parsed.event && appendEvent(db, parsed.event) ? 1 : 0;
}

async function tailFile(db: Database, source: TailSource, path: string): Promise<number> {
  const stat = statSync(path);
  const mtime = Math.floor(stat.mtimeMs);
  const saved = storedOffset(db, path);
  // A shrunk file was rewritten; dedupe keys make the rescan safe.
  const start = saved && saved.offset <= stat.size ? saved.offset : 0;
  if (saved && start === stat.size && saved.mtime === mtime) return 0;
  const bytes = Buffer.from(await Bun.file(path).slice(start, stat.size).arrayBuffer());
  const complete = bytes.lastIndexOf(0x0a) + 1;
  const sessionId = sessionIdOf(path);
  const skip = loggedViaAcp(db, sessionId);
  const ctx: LineContext = { file: path, sessionId };
  let added = 0;
  let pos = 0;
  while (!skip && pos < complete) {
    const end = bytes.indexOf(0x0a, pos);
    const line = bytes.toString("utf8", pos, end);
    if (line.trim()) added += applyLine(db, PARSERS[source.name](line, start + pos, ctx));
    pos = end + 1;
  }
  saveOffset(db, path, start + complete, mtime);
  return added;
}

export async function tailSources(db: Database, sources: TailSource[]): Promise<number> {
  let added = 0;
  for (const source of sources) {
    if (!existsSync(source.root)) continue;
    for (const rel of new Bun.Glob(source.glob).scanSync({ cwd: source.root })) {
      const path = join(source.root, rel);
      try {
        added += await tailFile(db, source, path);
      } catch (err) {
        // One vanished or unreadable file must not starve the rest of the sweep.
        console.warn(`usage tail skipped ${path}:`, err);
      }
    }
  }
  return added;
}
