import type { Database } from "bun:sqlite";
import type { RouteCandidateDecision, RouteDecisionView } from "../../../shared/router";

const MAX_CANDIDATES = 10;
const MAX_JSON_BYTES = 8192;
const RETENTION_MS = 30 * 24 * 60 * 60_000;

interface StoredPayload {
  total: number;
  candidates: RouteCandidateDecision[];
}

interface DecisionRow {
  id: string;
  run_id: string | null;
  ts: number;
  policy: string;
  candidates_json: string;
  chosen_account: string | null;
}

function encodeCandidates(all: RouteCandidateDecision[]): string {
  const ordered = [...all].sort((a, b) => {
    const ae = a.rejectedBy === null ? 0 : 1;
    const be = b.rejectedBy === null ? 0 : 1;
    if (ae !== be) return ae - be;
    return (b.score ?? -1) - (a.score ?? -1);
  });
  const kept = ordered.slice(0, MAX_CANDIDATES);
  let json = JSON.stringify({ total: all.length, candidates: kept } satisfies StoredPayload);
  while (kept.length > 0 && Buffer.byteLength(json, "utf8") > MAX_JSON_BYTES) {
    kept.pop();
    json = JSON.stringify({ total: all.length, candidates: kept } satisfies StoredPayload);
  }
  return json;
}

export function recordRouteDecision(
  db: Database,
  input: {
    ts: number;
    policy: string;
    chosenAccount: string | null;
    candidates: RouteCandidateDecision[];
    runId?: string | null;
  },
): string {
  const id = Bun.randomUUIDv7();
  db.run(
    `INSERT INTO route_decisions (id, run_id, ts, policy, candidates_json, chosen_account)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.runId ?? null,
      input.ts,
      input.policy,
      encodeCandidates(input.candidates),
      input.chosenAccount,
    ],
  );
  return id;
}

export function linkRouteDecision(db: Database, decisionId: string, runId: string): void {
  db.run("UPDATE route_decisions SET run_id = ? WHERE id = ?", [runId, decisionId]);
}

export function pruneRouteDecisions(db: Database, now: number = Date.now()): number {
  return db.run("DELETE FROM route_decisions WHERE ts < ?", [now - RETENTION_MS]).changes;
}

function parsePayload(raw: string): StoredPayload {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredPayload>;
    return {
      total: typeof parsed.total === "number" ? parsed.total : 0,
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
    };
  } catch {
    return { total: 0, candidates: [] };
  }
}

export function listRouteDecisions(
  db: Database,
  opts: { limit?: number; runId?: string } = {},
): RouteDecisionView[] {
  const limit = Math.max(1, Math.min(200, Math.trunc(opts.limit ?? 50)));
  const rows = opts.runId
    ? db
        .query<DecisionRow, [string, number]>(
          "SELECT * FROM route_decisions WHERE run_id = ? ORDER BY ts DESC, id DESC LIMIT ?",
        )
        .all(opts.runId, limit)
    : db
        .query<DecisionRow, [number]>(
          "SELECT * FROM route_decisions ORDER BY ts DESC, id DESC LIMIT ?",
        )
        .all(limit);
  return rows.map((r) => {
    const payload = parsePayload(r.candidates_json);
    return {
      id: r.id,
      runId: r.run_id,
      ts: r.ts,
      policy: r.policy,
      chosenAccount: r.chosen_account,
      totalCandidates: payload.total,
      candidates: payload.candidates,
    };
  });
}
