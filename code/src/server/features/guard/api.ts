import type { Database } from "bun:sqlite";
import type { ApprovalView } from "../../../shared/runs";
import { appendEvent, redact } from "../logs/api";
import {
  type ApprovalRow,
  awaitApproval,
  createApproval,
  decideApproval as decide,
  expireApprovals as expire,
  expireRunApprovals as expireRun,
  getApproval,
  listApprovals as list,
  approvalView as toApprovalView,
} from "./approvals";
import { claudeSettings as buildClaudeSettings, type ClaudeSettings } from "./claude-settings";
import { codexRules as buildCodexRules } from "./codex-rules";
import { type ActionRequest, type L1Result, evaluateL1 as l1Evaluate, type Scope } from "./l1";
import { escalateL2, type L2Result } from "./l2";
import {
  type SandboxInput,
  runTmpDir as sandboxRunTmpDir,
  scrubEnv as sandboxScrubEnv,
  wrapCommand as sandboxWrapCommand,
  writeSrtSettings as sandboxWriteSrtSettings,
} from "./sandbox";

export type { ApprovalRow } from "./approvals";
export type { ActionRequest, Category, L1Result, Scope } from "./l1";
export type { SandboxInput } from "./sandbox";

export interface GuardOutcome {
  verdict: "allow" | "deny";
  layer: "L1" | "L2" | "L3";
  reason: string;
  rule: string | null;
  approvalId: string | null;
}

interface CheckOpts {
  approvalTimeoutMs?: number;
  onApprovalPending?: (id: string) => void;
}

interface GuardRun {
  id: string;
  prompt: string;
  scope: Scope;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 600_000;

const approvalListeners = new Set<(approval: ApprovalView) => void>();

export function onApprovalChange(listener: (approval: ApprovalView) => void): () => void {
  approvalListeners.add(listener);
  return () => approvalListeners.delete(listener);
}

export function approvalView(row: ApprovalRow): ApprovalView {
  return toApprovalView(row);
}

export function findApproval(db: Database, id: string): ApprovalRow | null {
  return getApproval(db, id);
}

function notifyApproval(db: Database, id: string): void {
  const row = getApproval(db, id);
  if (!row) return;
  for (const listener of approvalListeners) {
    try {
      listener(toApprovalView(row));
    } catch (err) {
      console.error("approval listener failed", err);
    }
  }
}

export function decideApproval(
  db: Database,
  id: string,
  decision: "approve" | "deny",
  by: string,
): boolean {
  return decide(db, id, decision, by);
}

export function listApprovals(db: Database, status?: string): ApprovalRow[] {
  return list(db, status);
}

export function expireApprovals(db: Database, now: number): number {
  return expire(db, now);
}

export function expireRunApprovals(db: Database, runId: string): number {
  return expireRun(db, runId);
}

export function claudeSettings(bin: string, script: string): ClaudeSettings {
  return buildClaudeSettings(bin, script);
}

export function codexRules(): string {
  return buildCodexRules();
}

export function evaluateL1(action: ActionRequest, scope: Scope): L1Result {
  return l1Evaluate(action, scope);
}

export function writeSrtSettings(input: SandboxInput): Promise<string> {
  return sandboxWriteSrtSettings(input);
}

export function wrapCommand(settingsPath: string, argv: string[]): string[] {
  return sandboxWrapCommand(settingsPath, argv);
}

export function scrubEnv(
  env: Record<string, string | undefined>,
  extra: Record<string, string>,
): Record<string, string> {
  return sandboxScrubEnv(env, extra);
}

export function runTmpDir(runDir: string): string {
  return sandboxRunTmpDir(runDir);
}

function approvalTimeout(opts: CheckOpts | undefined): number {
  const fromEnv = Number(process.env.HARNESS_APPROVAL_TIMEOUT_MS);
  return opts?.approvalTimeoutMs ?? (fromEnv > 0 ? fromEnv : DEFAULT_APPROVAL_TIMEOUT_MS);
}

function logLayer(
  db: Database,
  run: GuardRun,
  layer: "L1" | "L2" | "L3",
  verdict: "allow" | "ask" | "deny",
  rule: string | null,
  command: string,
  reason: string,
): void {
  appendEvent(db, {
    runId: run.id,
    kind: "guard",
    guardLayer: layer,
    guardVerdict: verdict,
    ...(rule === null ? {} : { guardRule: rule }),
    command,
    body: reason,
  });
}

function redactAction(action: ActionRequest): ActionRequest {
  return {
    ...action,
    ...(action.command === undefined ? {} : { command: redact(action.command) }),
    ...(action.title === undefined ? {} : { title: redact(action.title) }),
    paths: action.paths.map(redact),
  };
}

function redactReason<T extends { reason: string }>(result: T): T {
  return { ...result, reason: redact(result.reason) };
}

async function askHuman(
  db: Database,
  run: GuardRun,
  action: ActionRequest,
  l1: L1Result,
  l2: L2Result | null,
  opts: CheckOpts | undefined,
): Promise<GuardOutcome> {
  const { id, expiresAt } = createApproval(db, {
    runId: run.id,
    action: JSON.stringify(redactAction(action)),
    l1: JSON.stringify(redactReason(l1)),
    l2: l2 ? JSON.stringify(redactReason(l2)) : null,
    timeoutMs: approvalTimeout(opts),
  });
  opts?.onApprovalPending?.(id);
  notifyApproval(db, id);
  const status = await awaitApproval(db, id, expiresAt);
  notifyApproval(db, id);
  const approved = status === "approved";
  const reason = approved ? "approved" : status === "denied" ? "denied" : "approval_timeout";
  logLayer(
    db,
    run,
    "L3",
    approved ? "allow" : "deny",
    l1.rule,
    action.command ?? action.paths.join(" "),
    reason,
  );
  return {
    verdict: approved ? "allow" : "deny",
    layer: "L3",
    reason,
    rule: l1.rule,
    approvalId: id,
  };
}

export async function checkAction(
  db: Database,
  run: GuardRun,
  action: ActionRequest,
  opts?: CheckOpts,
): Promise<GuardOutcome> {
  const command = action.command ?? action.paths.join(" ");
  const l1 = l1Evaluate(action, run.scope);
  logLayer(db, run, "L1", l1.verdict, l1.rule, command, l1.reason);
  if (l1.verdict === "deny") {
    return { verdict: "deny", layer: "L1", reason: l1.reason, rule: l1.rule, approvalId: null };
  }
  let l2: L2Result | null = null;
  if (l1.verdict === "allow") {
    l2 = await escalateL2({ request: run.prompt, command }, l1);
    logLayer(db, run, "L2", l2.verdict, l2.source, command, l2.reason);
    if (l2.verdict !== "ask") {
      return {
        verdict: l2.verdict,
        layer: l2.source === "laya" ? "L2" : "L1",
        reason: l2.reason,
        rule: l2.verdict === "deny" ? l2.source : l1.rule,
        approvalId: null,
      };
    }
  }
  return askHuman(db, run, action, l1, l2, opts);
}
