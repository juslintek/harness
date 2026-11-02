import type { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { appendEvent } from "../logs/api";
import { type LineContext, type ParsedLine, parseClaudeLine } from "./claude-tail";
import { parseCodexLine } from "./codex-tail";
import { insertSnapshotIfChanged } from "./quota";

export interface TailSource {
  name: "claude" | "codex";
  glob: string;
  root: string;
  // Sessions whose cwd is under this dir belong to harness runs, which record their own usage.
  excludeCwdUnder?: string;
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

function firstCwd(path: string): string | null {
  const buf = Buffer.alloc(65536);
  const fd = openSync(path, "r");
  try {
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString("utf8", 0, n).split("\n")) {
      const m = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m?.[1]) return JSON.parse(`"${m[1]}"`) as string;
    }
  } finally {
    closeSync(fd);
  }
  return null;
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function inHarnessWorktree(path: string, dir: string | undefined): boolean {
  if (dir === undefined) return false;
  const cwd = firstCwd(path);
  if (cwd === null) return false;
  return [dir, realOrSelf(dir)].some((d) => cwd === d || cwd.startsWith(`${d}/`));
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

const CHUNK_BYTES = 1024 * 1024;
const BATCH_LINES = 500;
const DAY_MS = 86_400_000;

function backfillCutoff(): number {
  const days = Number(process.env.HARNESS_TAIL_BACKFILL_DAYS ?? 30);
  return Date.now() - (Number.isFinite(days) && days >= 0 ? days : 30) * DAY_MS;
}

interface PendingLine {
  text: string;
  offset: number;
}

// Splits on the newline byte before decoding so a multi-byte character cut by a chunk border stays intact.
function completeLines(buf: Buffer, bufStart: number): { lines: PendingLine[]; consumed: number } {
  const lines: PendingLine[] = [];
  let pos = 0;
  for (let end = buf.indexOf(0x0a, pos); end !== -1; end = buf.indexOf(0x0a, pos)) {
    lines.push({ text: buf.toString("utf8", pos, end), offset: bufStart + pos });
    pos = end + 1;
  }
  return { lines, consumed: pos };
}

function applyBatches(db: Database, lines: PendingLine[], parse: Parser, ctx: LineContext): number {
  let added = 0;
  for (let i = 0; i < lines.length; i += BATCH_LINES) {
    const batch = lines.slice(i, i + BATCH_LINES);
    added += db.transaction((): number => {
      let n = 0;
      for (const { text, offset } of batch)
        if (text.trim()) n += applyLine(db, parse(text, offset, ctx));
      return n;
    })();
  }
  return added;
}

async function tailFile(db: Database, source: TailSource, path: string): Promise<number> {
  const stat = statSync(path);
  const mtime = Math.floor(stat.mtimeMs);
  const saved = storedOffset(db, path);
  if (!saved && mtime < backfillCutoff()) {
    saveOffset(db, path, stat.size, mtime);
    return 0;
  }
  // A shrunk file was rewritten; dedupe keys make the rescan safe.
  const start = saved && saved.offset <= stat.size ? saved.offset : 0;
  if (saved && start === stat.size && saved.mtime === mtime) return 0;
  const sessionId = sessionIdOf(path);
  if (loggedViaAcp(db, sessionId) || inHarnessWorktree(path, source.excludeCwdUnder)) {
    saveOffset(db, path, stat.size, mtime);
    return 0;
  }
  const ctx: LineContext = { file: path, sessionId };
  // One reused read buffer; a fresh ArrayBuffer per chunk is freed lazily by the collector.
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  const fd = openSync(path, "r");
  let added = 0;
  let readPos = start;
  let carry: Buffer = Buffer.alloc(0);
  try {
    while (readPos < stat.size) {
      const n = readSync(fd, chunk, 0, Math.min(CHUNK_BYTES, stat.size - readPos), readPos);
      if (n === 0) break;
      readPos += n;
      const buf =
        carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      const { lines, consumed } = completeLines(buf, readPos - buf.length);
      added += applyBatches(db, lines, PARSERS[source.name], ctx);
      carry = Buffer.from(buf.subarray(consumed));
      saveOffset(db, path, readPos - carry.length, mtime);
      // The collector runs lazily; without this a multi-GB backfill piled up to ~270 MB in-process.
      Bun.gc(true);
      // Lets the HTTP server run between chunks of a large backfill.
      await Bun.sleep(0);
    }
  } finally {
    closeSync(fd);
  }
  return added;
}

const sweeping = new WeakSet<Database>();

export async function tailSources(db: Database, sources: TailSource[]): Promise<number> {
  if (sweeping.has(db)) return 0;
  sweeping.add(db);
  try {
    return await sweep(db, sources);
  } finally {
    sweeping.delete(db);
  }
}

async function sweep(db: Database, sources: TailSource[]): Promise<number> {
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
