import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { ASK_DESTRUCTIVE, DENY_EXFILTRATION } from "../src/server/features/guard/l2";

export interface Sample {
  destructive: number;
  approved: boolean;
}

export interface Fit {
  threshold: number;
  wrongEscalations: number;
  misses: number;
}

// An approval row exists only when L2 asked, so every sample was escalated at the current line.
// An approved decision is a wrong escalation at thresholds <= its score; a denied decision is a
// miss at thresholds above its score.
export function confusionAt(samples: Sample[], threshold: number): Fit {
  let wrongEscalations = 0;
  let misses = 0;
  for (const s of samples) {
    if (s.destructive >= threshold && s.approved) wrongEscalations++;
    if (s.destructive < threshold && !s.approved) misses++;
  }
  return { threshold, wrongEscalations, misses };
}

export function bestFit(samples: Sample[], current: number): Fit {
  let best = confusionAt(samples, current);
  const candidates = new Set(samples.map((s) => Number((s.destructive + 0.001).toFixed(3))));
  for (const threshold of [...candidates].sort((a, b) => a - b)) {
    const fit = confusionAt(samples, threshold);
    if (fit.wrongEscalations + fit.misses < best.wrongEscalations + best.misses) best = fit;
  }
  return best;
}

interface ApprovalRow {
  status: string;
  l2: string;
}

function destructiveOf(l2: string): number | null {
  const probs: unknown = (JSON.parse(l2) as { probs?: unknown }).probs;
  if (typeof probs !== "object" || probs === null) return null;
  const value = (probs as Record<string, unknown>).destructive;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function main(path: string): void {
  if (!existsSync(path)) {
    console.log(`no audit log on this machine (${path} does not exist)`);
    return;
  }
  const db = new Database(path, { readonly: true });
  const rows = db
    .query<ApprovalRow, []>(
      "SELECT status, l2 FROM approvals WHERE status IN ('approved', 'denied') AND l2 IS NOT NULL",
    )
    .all();
  const samples: Sample[] = [];
  for (const row of rows) {
    const destructive = destructiveOf(row.l2);
    if (destructive !== null) samples.push({ destructive, approved: row.status === "approved" });
  }
  const l2Events = db
    .query<{ guard_verdict: string; n: number }, []>(
      "SELECT guard_verdict, count(*) AS n FROM events WHERE kind = 'guard' AND guard_layer = 'L2' GROUP BY guard_verdict",
    )
    .all();

  console.log(`decided approvals with l2 probabilities: n = ${samples.length}`);
  console.log(
    `decided approvals with an l2 column but no probabilities: ${rows.length - samples.length}`,
  );
  console.log(
    `L2 guard events by verdict (event rows hold no probabilities): ${
      l2Events.map((e) => `${e.guard_verdict}=${e.n}`).join(", ") || "none"
    }`,
  );
  console.log(
    `exfiltration (deny >= ${DENY_EXFILTRATION}) cannot be refit: an L2 deny creates no approval, so no human decision exists for it`,
  );
  if (samples.length === 0) {
    console.log("cannot refit: no decided samples with stored probabilities");
    return;
  }
  const current = confusionAt(samples, ASK_DESTRUCTIVE);
  const best = bestFit(samples, ASK_DESTRUCTIVE);
  console.log(
    `destructive ask threshold ${ASK_DESTRUCTIVE}: wrong escalations ${current.wrongEscalations}, misses ${current.misses}`,
  );
  console.log(
    `best threshold ${best.threshold}: wrong escalations ${best.wrongEscalations}, misses ${best.misses}`,
  );
  console.log(
    "caveat: every sample was already escalated, so misses of commands L2 allowed are not visible",
  );
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: bun scripts/l2-refit.ts <path to harness.db copy>");
    process.exit(2);
  }
  main(path);
}
