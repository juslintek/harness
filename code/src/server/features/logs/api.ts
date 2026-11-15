import type { Database } from "bun:sqlite";
import { redactSecrets } from "./redact";
import {
  type EventDbRow,
  indexEvent,
  insertEvent,
  matchRowids,
  pendingBody,
  selectEvents,
} from "./repo";
import { DEFAULT_MIN_BYTES, readSegmentBody, sealPending } from "./segments";

export type EventKind =
  | "run"
  | "message"
  | "tool_call"
  | "permission"
  | "guard"
  | "usage"
  | "approval"
  | "process"
  | "error"
  | "account.linked"
  | "account.unlinked"
  | "account.added"
  | "account.enabled"
  | "account.disabled"
  | "account.removed"
  | "account.remove_failed";

export type NewEvent = {
  runId?: string;
  taskId?: string;
  agent?: string;
  kind: EventKind;
  operation?: string;
  toolName?: string;
  conversationId?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  reportedCostUsd?: number;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  guardLayer?: "L0" | "L1" | "L2" | "L3" | "L4";
  guardVerdict?: "allow" | "ask" | "deny";
  guardRule?: string;
  accountId?: string;
  source?: string;
  dedupeKey?: string;
  body?: string;
  ts?: number;
};

export interface EventRow {
  rowid: number;
  id: string;
  ts: number;
  runId: string | null;
  taskId: string | null;
  agent: string | null;
  kind: EventKind;
  operation: string | null;
  toolName: string | null;
  conversationId: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  reportedCostUsd: number | null;
  command: string | null;
  exitCode: number | null;
  durationMs: number | null;
  guardLayer: string | null;
  guardVerdict: string | null;
  guardRule: string | null;
  source: string | null;
  dedupeKey: string | null;
  segmentId: string | null;
}

export interface SearchHit {
  rowid: number;
  id: string;
  runId: string | null;
  kind: string;
  ts: number;
  snippet: string;
}

export function redact(text: string): string {
  return redactSecrets(text);
}

// Secrets are scrubbed here, before any pending, segment or FTS write.
export function appendEvent(db: Database, e: NewEvent): { id: string; rowid: number } | null {
  const id = Bun.randomUUIDv7();
  const command = e.command === undefined ? null : redact(e.command);
  const body = e.body === undefined ? null : redact(e.body);
  const fields = {
    ...e,
    command: command ?? undefined,
    toolName: e.toolName === undefined ? undefined : redact(e.toolName),
    guardRule: e.guardRule === undefined ? undefined : redact(e.guardRule),
  };
  // Immediate, so the dedupe check in insertEvent and the insert cannot interleave with a writer.
  return db
    .transaction((): { id: string; rowid: number } | null => {
      const rowid = insertEvent(db, id, e.ts ?? Date.now(), fields);
      if (rowid === null) return null;
      indexEvent(db, rowid, e.runId ?? null, body, command);
      return { id, rowid };
    })
    .immediate();
}

export function sealSegments(
  db: Database,
  opts: { runId?: string; minBytes?: number } = {},
): number {
  return sealPending(db, opts.runId, opts.minBytes ?? DEFAULT_MIN_BYTES);
}

export function readBody(db: Database, rowid: number): string | null {
  const pending = pendingBody(db, rowid);
  if (pending !== null) return pending;
  const [ev] = selectEvents(db, "rowid = ?", [rowid]);
  if (!ev?.segment_id || ev.seg_offset === null || ev.seg_len === null) return null;
  return readSegmentBody(db, ev.segment_id, ev.seg_offset, ev.seg_len);
}

function toRow(r: EventDbRow): EventRow {
  return {
    rowid: r.rowid,
    id: r.id,
    ts: r.ts,
    runId: r.run_id,
    taskId: r.task_id,
    agent: r.agent,
    kind: r.kind as EventKind,
    operation: r.gen_ai_operation_name,
    toolName: r.gen_ai_tool_name,
    conversationId: r.gen_ai_conversation_id,
    model: r.gen_ai_request_model,
    inputTokens: r.gen_ai_usage_input_tokens,
    outputTokens: r.gen_ai_usage_output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    reasoningTokens: r.reasoning_tokens,
    reportedCostUsd: r.reported_cost_usd,
    command: r.command,
    exitCode: r.exit_code,
    durationMs: r.duration_ms,
    guardLayer: r.guard_layer,
    guardVerdict: r.guard_verdict,
    guardRule: r.guard_rule,
    source: r.source,
    dedupeKey: r.dedupe_key,
    segmentId: r.segment_id,
  };
}

export function listRunEvents(db: Database, runId: string, afterRowid = 0): EventRow[] {
  return selectEvents(db, "run_id = ? AND rowid > ?", [runId, afterRowid]).map(toRow);
}

const SNIPPET_RADIUS = 60;

function cut(text: string, needle: string): string | null {
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return null;
  return text.slice(Math.max(0, at - SNIPPET_RADIUS), at + needle.length + SNIPPET_RADIUS);
}

export function snippetFor(body: string | null, command: string | null, q: string): string {
  const needles = [q.trim(), ...(q.match(/[\p{L}\p{N}]+/gu) ?? [])];
  for (const needle of needles) {
    for (const text of [body, command]) {
      const hit = text === null ? null : cut(text, needle);
      if (hit !== null) return hit;
    }
  }
  return (body ?? command ?? "").slice(0, SNIPPET_RADIUS * 2);
}

export function searchEvents(db: Database, q: string, limit = 20): SearchHit[] {
  const rowids = matchRowids(db, q, limit);
  if (rowids.length === 0) return [];
  const marks = rowids.map(() => "?").join(",");
  const byRowid = new Map(selectEvents(db, `rowid IN (${marks})`, rowids).map((r) => [r.rowid, r]));
  const hits: SearchHit[] = [];
  for (const rowid of rowids) {
    const ev = byRowid.get(rowid);
    if (!ev) continue;
    hits.push({
      rowid,
      id: ev.id,
      runId: ev.run_id,
      kind: ev.kind,
      ts: ev.ts,
      snippet: snippetFor(readBody(db, rowid), ev.command, q),
    });
  }
  return hits;
}
