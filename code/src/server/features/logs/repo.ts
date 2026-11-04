import type { Database } from "bun:sqlite";

export interface EventDbRow {
  rowid: number;
  id: string;
  ts: number;
  run_id: string | null;
  task_id: string | null;
  agent: string | null;
  kind: string;
  gen_ai_operation_name: string | null;
  gen_ai_tool_name: string | null;
  gen_ai_conversation_id: string | null;
  gen_ai_request_model: string | null;
  gen_ai_usage_input_tokens: number | null;
  gen_ai_usage_output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  reported_cost_usd: number | null;
  command: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  guard_layer: string | null;
  guard_verdict: string | null;
  guard_rule: string | null;
  source: string | null;
  dedupe_key: string | null;
  segment_id: string | null;
  seg_offset: number | null;
  seg_len: number | null;
}

const INSERT_SQL = `INSERT INTO events (id, ts, run_id, task_id, agent, kind,
  gen_ai_operation_name, gen_ai_tool_name, gen_ai_conversation_id, gen_ai_request_model,
  gen_ai_usage_input_tokens, gen_ai_usage_output_tokens, cache_read_tokens, cache_write_tokens,
  reasoning_tokens, reported_cost_usd, command, exit_code, duration_ms, guard_layer,
  guard_verdict, guard_rule, source, dedupe_key)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// Order matches INSERT_SQL after id and ts.
const FIELD_KEYS = [
  "runId",
  "taskId",
  "agent",
  "kind",
  "operation",
  "toolName",
  "conversationId",
  "model",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "reportedCostUsd",
  "command",
  "exitCode",
  "durationMs",
  "guardLayer",
  "guardVerdict",
  "guardRule",
  "source",
  "dedupeKey",
] as const;

type Fields = Readonly<Record<string, string | number | undefined>>;

// Returns the new rowid, or null when dedupe_key already exists. The check is explicit because
// the events_no_replace trigger fires before any ON CONFLICT clause could absorb the duplicate.
export function insertEvent(db: Database, id: string, ts: number, fields: Fields): number | null {
  const key = fields.dedupeKey;
  if (key !== undefined && db.query("SELECT 1 FROM events WHERE dedupe_key = ?").get(key)) {
    return null;
  }
  const res = db.run(INSERT_SQL, [id, ts, ...FIELD_KEYS.map((k) => fields[k] ?? null)]);
  return Number(res.lastInsertRowid);
}

export function indexEvent(
  db: Database,
  rowid: number,
  runId: string | null,
  body: string | null,
  command: string | null,
): void {
  if (body !== null) {
    db.run("INSERT INTO pending_payloads (event_rowid, run_id, body) VALUES (?, ?, ?)", [
      rowid,
      runId,
      body,
    ]);
    db.run("INSERT INTO events_fts (rowid, body) VALUES (?, ?)", [rowid, body]);
  }
  if (command !== null) {
    db.run("INSERT INTO commands_fts (rowid, text) VALUES (?, ?)", [rowid, command]);
  }
}

export function pendingBody(db: Database, rowid: number): string | null {
  const row = db
    .query<{ body: string }, [number]>("SELECT body FROM pending_payloads WHERE event_rowid = ?")
    .get(rowid);
  return row?.body ?? null;
}

export function selectEvents(
  db: Database,
  where: string,
  params: Array<string | number>,
): EventDbRow[] {
  return db
    .query<EventDbRow, Array<string | number>>(
      `SELECT rowid, * FROM events WHERE ${where} ORDER BY rowid`,
    )
    .all(...params);
}

// FTS5 MATCH takes a query language; quoting each term keeps user input literal.
function quote(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

// detail=column forbids phrase queries, so a substring is searched as the AND of its distinct
// 3-grams (single-token terms). That over-matches; matchCommands re-checks the real substring.
function trigramQuery(text: string): string {
  const grams = new Set<string>();
  const chars = [...text.toLowerCase()];
  for (let i = 0; i + 3 <= chars.length; i++) grams.add(chars.slice(i, i + 3).join(""));
  return [...grams].map(quote).join(" AND ");
}

// Restricts candidates inside the FTS query, so the limit is applied after the filter.
export interface RowidScope {
  sql: string;
  params: Array<string | number>;
  // Cap the candidates by recency instead of rank, so the newest matches are never cut.
  newestFirst?: boolean;
}

function matchRowidsIn(
  db: Database,
  table: string,
  match: string,
  limit: number,
  scope?: RowidScope,
): number[] {
  const sql = scope?.newestFirst
    ? `SELECT ${table}.rowid FROM ${table} JOIN events e ON e.rowid = ${table}.rowid
       WHERE ${table} MATCH ? AND ${table}.rowid IN (${scope.sql}) ORDER BY e.ts DESC, e.rowid DESC LIMIT ?`
    : `SELECT rowid FROM ${table} WHERE ${table} MATCH ?${scope ? ` AND rowid IN (${scope.sql})` : ""} ORDER BY rank LIMIT ?`;
  return db
    .query<{ rowid: number }, Array<string | number>>(sql)
    .all(match, ...(scope?.params ?? []), limit)
    .map((r) => r.rowid);
}

function matchCommands(db: Database, q: string, limit: number, scope?: RowidScope): number[] {
  // The trigram tokenizer needs at least 3 characters to match anything.
  if ([...q].length < 3) return [];
  const needle = q.toLowerCase();
  const commandOf = db.query<{ command: string | null }, [number]>(
    "SELECT command FROM events WHERE rowid = ?",
  );
  return matchRowidsIn(db, "commands_fts", trigramQuery(q), limit * 5, scope)
    .filter((rowid) => commandOf.get(rowid)?.command?.toLowerCase().includes(needle))
    .slice(0, limit);
}

export function matchRowids(db: Database, q: string, limit: number, scope?: RowidScope): number[] {
  const words = q.match(/[\p{L}\p{N}]+/gu) ?? [];
  const ids = new Set<number>();
  if (words.length > 0) {
    for (const rowid of matchRowidsIn(db, "events_fts", words.map(quote).join(" "), limit, scope)) {
      ids.add(rowid);
    }
  }
  for (const rowid of matchCommands(db, q.trim(), limit, scope)) ids.add(rowid);
  // Each source is already capped; slicing the union would drop the newest of the second one.
  return scope?.newestFirst ? [...ids] : [...ids].slice(0, limit);
}
