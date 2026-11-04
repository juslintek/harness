// Helpers for scripts/smoke.ts: the approval policy, the run summary and the tee log reader.
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decideApproval, listApprovals } from "../src/server/features/guard/api";
import { listRunEvents } from "../src/server/features/logs/api";

export const approvalLog: string[] = [];

function insideScope(token: string, worktree: string): boolean {
  if (!token.startsWith("/") && !token.startsWith("~")) return true;
  return token.startsWith(worktree);
}

interface Pending {
  kind: string;
  command?: string;
  paths: string[];
}

// A pending approval means L1 asked or L2 (Laya) raised an L1 allow. L1 allow stands, since srt
// still confines the process. L1 asks are approved only inside the worktree or for read-only
// commands on the user's installed skill files (Codex loads them).
function approvable(action: Pending, l1: { verdict: string }, worktree: string): boolean {
  if (l1.verdict === "deny") return false;
  if (l1.verdict === "allow") return true;
  if (action.kind === "edit") return action.paths.every((p) => p.startsWith(worktree));
  if (action.kind !== "execute" || !action.command) return false;
  const [bin = "", ...rest] = action.command.split(/\s+/);
  const skillRoots = [".agents", ".claude", ".codex"].map((d) => join(homedir(), d, "skills"));
  const isSkillFile = (t: string): boolean => skillRoots.some((r) => t.startsWith(`${r}/`));
  const readOnly = ["cat", "sed", "head", "ls", "rg"].includes(bin);
  if (readOnly && rest.every((t) => /^(-|[\d,]+p$)/.test(t) || isSkillFile(t))) {
    return true;
  }
  return action.command.split(/\s+/).every((t) => insideScope(t, worktree));
}

function readWorktree(db: Database, runId: string): string | null {
  const row = db
    .query<{ worktree: string | null }, [string]>("SELECT worktree FROM runs WHERE id = ?")
    .get(runId);
  return row?.worktree ?? null;
}

export function watchApprovals(db: Database, runId: string): () => void {
  const seen = new Set<string>();
  const timer = setInterval(() => {
    const worktree = readWorktree(db, runId);
    for (const a of listApprovals(db, "pending")) {
      if (a.runId !== runId || seen.has(a.id) || worktree === null) continue;
      seen.add(a.id);
      const ok = approvable(JSON.parse(a.action), JSON.parse(a.l1), worktree);
      decideApproval(db, a.id, ok ? "approve" : "deny", "smoke");
      const verdict = ok ? "approved" : "DENIED";
      approvalLog.push(`${runId.slice(-6)} ${verdict} ${a.action} l1=${a.l1} l2=${a.l2}`);
    }
  }, 100);
  return () => clearInterval(timer);
}

export interface Leftovers {
  // One line per approval the script had to decide itself, with the command it was about.
  decided: string[];
  stop: () => void;
}

const LEFTOVER_POLL_MS = 500;

// Approvals belong to managers and policy first; the script only takes what nobody decided within
// graceMs, so the gate's count shows how much the agents could not settle on their own.
export function watchLeftovers(db: Database, opts: { graceMs?: number } = {}): Leftovers {
  const graceMs = opts.graceMs ?? 90_000;
  const firstSeen = new Map<string, number>();
  const decided: string[] = [];
  const timer = setInterval(() => {
    const now = Date.now();
    for (const a of listApprovals(db, "pending")) {
      const since = firstSeen.get(a.id) ?? now;
      firstSeen.set(a.id, since);
      if (now - since >= graceMs) settleLeftover(db, a, decided);
    }
  }, LEFTOVER_POLL_MS);
  return { decided, stop: () => clearInterval(timer) };
}

function settleLeftover(
  db: Database,
  a: ReturnType<typeof listApprovals>[number],
  decided: string[],
): void {
  const worktree = readWorktree(db, a.runId);
  if (worktree === null) return;
  const action: Pending = JSON.parse(a.action);
  const ok = approvable(action, JSON.parse(a.l1), worktree);
  // False means a manager decided it between the listing and now; that one is not ours.
  if (!decideApproval(db, a.id, ok ? "approve" : "deny", "gate")) return;
  const what = action.command ?? `${action.kind} ${action.paths.join(" ")}`;
  decided.push(`${ok ? "approved" : "DENIED"} ${what}`);
}

export interface Row {
  agent: string;
  state: string;
  secs: number;
  tokens: string;
  approvals: number;
  denies: number;
}

type TokenKey = "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens";

export function sumTokens(db: Database, runId: string, key: TokenKey): number {
  return listRunEvents(db, runId)
    .filter((e) => e.kind === "usage")
    .reduce((n, e) => n + (e[key] ?? 0), 0);
}

export function summarize(
  db: Database,
  agent: string,
  runId: string,
  state: string,
  t0: number,
): Row {
  const events = listRunEvents(db, runId);
  const t = (k: TokenKey): number => sumTokens(db, runId, k);
  return {
    agent,
    state,
    secs: Math.round((Date.now() - t0) / 100) / 10,
    tokens: `${t("inputTokens")}/${t("outputTokens")}/${t("cacheReadTokens")}+${t("cacheWriteTokens")}`,
    approvals: events.filter((e) => e.kind === "approval").length,
    denies: events.filter((e) => e.kind === "guard" && e.guardVerdict === "deny").length,
  };
}

interface Frame {
  method?: string;
  params?: { update?: { sessionUpdate?: string } };
  result?: { usage?: unknown; stopReason?: unknown; _meta?: { quota?: unknown } };
}

export function wireStats(logPath: string): string {
  if (!existsSync(logPath)) return "no tee log";
  const frames: Frame[] = readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const updates = frames.filter((f) => f.method === "session/update");
  const count = (t: string): number =>
    updates.filter((f) => f.params?.update?.sessionUpdate === t).length;
  const prompts = frames.filter((f) => f.result?.stopReason !== undefined);
  return JSON.stringify({
    usage_update: count("usage_update"),
    agent_message_chunk: count("agent_message_chunk"),
    tool_call: count("tool_call"),
    promptResponses: prompts.map((p) => ({
      usage: p.result?.usage,
      quota: p.result?._meta?.quota,
    })),
  });
}

export function describe(db: Database, runId: string): void {
  const events = listRunEvents(db, runId);
  const denies = events.filter((e) => e.guardVerdict === "deny");
  console.log(
    `   denies: ${denies.map((e) => `${e.guardRule} ${e.command}`).join(" | ") || "none"}`,
  );
  const usage = events
    .filter((e) => e.kind === "usage")
    .map((e) => [
      e.model,
      e.inputTokens,
      e.outputTokens,
      e.cacheReadTokens,
      e.cacheWriteTokens,
      e.reasoningTokens,
      e.reportedCostUsd,
    ]);
  console.log(`   usage events [model,in,out,cacheR,cacheW,reason,cost]: ${JSON.stringify(usage)}`);
}
