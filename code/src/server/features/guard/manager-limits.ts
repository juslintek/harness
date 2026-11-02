import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../logs/api";
import { getMember, managerPositionsOf, reportsTransitivelyTo } from "../orgs/api";
import { type ApprovalRow, decideApproval, getApproval, listApprovals } from "./approvals";

export interface DecideContext {
  requesterMemberId: string | null;
  managerMemberId: string;
  inSubtree: boolean;
  category: string | null;
  kind: string;
  command: string;
  paths: string[];
  harnessHome: string;
}

// Text that points at the harness itself, its sandbox or its agent config: a manager agent must
// never wave those through, whoever asks.
const FORBIDDEN = [
  "/features/guard",
  "/features/auth",
  "/features/policies",
  "deploy",
  "srt",
  "sandbox",
  ".claude/settings",
  ".codex/",
  "codex_home",
  "harness_",
];

export function managerMayDecide(ctx: DecideContext): string | null {
  if (ctx.requesterMemberId === null) return "the run has no member";
  if (ctx.requesterMemberId === ctx.managerMemberId)
    return "managers cannot decide their own request";
  if (!ctx.inSubtree) return "the requester does not report to you";
  if (ctx.category === "network" || ctx.category === "secret" || ctx.kind === "fetch") {
    return "network and secret actions need a human";
  }
  const text = [ctx.command, ...ctx.paths].join("\n").toLowerCase();
  if (text.includes(ctx.harnessHome.toLowerCase())) return "the action touches the harness home";
  const hit = FORBIDDEN.find((word) => text.includes(word));
  return hit === undefined ? null : `the action mentions ${hit}`;
}

function field(json: string | null, key: string): unknown {
  try {
    const value: unknown = json === null ? null : JSON.parse(json);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function harnessHome(): string {
  return process.env.HARNESS_HOME ?? join(homedir(), ".harness");
}

function contextFor(db: Database, approval: ApprovalRow, managerMemberId: string): DecideContext {
  const run = db
    .query<{ member_id: string | null }, [string]>("SELECT member_id FROM runs WHERE id = ?")
    .get(approval.runId);
  const requesterMemberId = run?.member_id ?? null;
  const requester = requesterMemberId === null ? null : getMember(db, requesterMemberId);
  const inSubtree =
    requester !== null &&
    managerPositionsOf(db, managerMemberId).some(
      (p) => p.orgId === requester.orgId && reportsTransitivelyTo(db, requester.id, p.id),
    );
  const paths = field(approval.action, "paths");
  return {
    requesterMemberId,
    managerMemberId,
    inSubtree,
    category: str(field(approval.l1, "category")) || null,
    kind: str(field(approval.action, "kind")),
    command: str(field(approval.action, "command")),
    paths: Array.isArray(paths) ? paths.map(str) : [],
    harnessHome: harnessHome(),
  };
}

export function decidableApprovals(db: Database, managerMemberId: string): ApprovalRow[] {
  return listApprovals(db, "pending").filter(
    (a) => managerMayDecide(contextFor(db, a, managerMemberId)) === null,
  );
}

export function managerDecide(
  db: Database,
  input: {
    approvalId: string;
    managerMemberId: string;
    decision: "approve" | "deny";
    reason: string;
  },
): { ok: true } | { ok: false; reason: string } {
  const approval = getApproval(db, input.approvalId);
  if (!approval) return { ok: false, reason: "unknown approval" };
  const ctx = contextFor(db, approval, input.managerMemberId);
  const refusal = managerMayDecide(ctx);
  if (refusal !== null) return { ok: false, reason: refusal };
  if (!decideApproval(db, approval.id, input.decision, `agent:${input.managerMemberId}`)) {
    return { ok: false, reason: "not pending" };
  }
  appendEvent(db, {
    runId: approval.runId,
    kind: "guard",
    guardLayer: "L3",
    guardVerdict: input.decision === "approve" ? "allow" : "deny",
    guardRule: input.reason,
    source: "manager_agent",
    command: ctx.command || ctx.paths.join(" "),
    body: `${input.decision} by agent:${input.managerMemberId}`,
  });
  return { ok: true };
}
