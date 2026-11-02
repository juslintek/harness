import type { Database } from "bun:sqlite";
import { basename, posix, resolve } from "node:path";
import { appendEvent } from "../logs/api";
import { getMember, managerPositionsOf, reportsTransitivelyTo } from "../orgs/api";
import { type ApprovalRow, decideApproval, getApproval, listApprovals } from "./approvals";

export interface DecideContext {
  requesterMemberId: string | null;
  managerMemberId: string;
  inSubtree: boolean;
  category: string | null;
  rule: string | null;
  kind: string;
  command: string;
  paths: string[];
  harnessHome: string;
}

// Text that points at the harness itself, its sandbox or its agent config: a manager agent must
// never wave those through, whoever asks. Matched without a leading slash so relative paths count.
const FORBIDDEN = [
  "features/guard",
  "features/auth",
  "features/policies",
  "deploy",
  "srt",
  "sandbox",
  ".claude/settings",
  ".codex/",
  "codex_home",
  "harness_",
];
// A guard rule that means the guard could not see what really runs or that widens the scope.
const BLIND_RULES = ["exec.escalate", "env.injection"];

// `..` is resolved per word so `/repo/../../x/.harness` cannot hide the target; `/./` and
// repeated slashes are collapsed first.
function normalizeText(text: string): string {
  const flat = text
    .toLowerCase()
    .replace(/\/+/g, "/")
    .replace(/(\/\.)+(?=\/|$)/g, "");
  const words = flat.split(/[\s"'=:;|&<>()]+/).filter((w) => w.includes("/"));
  return [flat, ...words.map((w) => posix.normalize(w))].join("\n");
}

export function managerMayDecide(ctx: DecideContext): string | null {
  if (ctx.requesterMemberId === null) return "the run has no member";
  if (ctx.requesterMemberId === ctx.managerMemberId)
    return "managers cannot decide their own request";
  if (!ctx.inSubtree) return "the requester does not report to you";
  if (ctx.category === "network" || ctx.category === "secret" || ctx.kind === "fetch") {
    return "network and secret actions need a human";
  }
  if (ctx.rule !== null && (ctx.rule.endsWith(".outside-root") || BLIND_RULES.includes(ctx.rule))) {
    return `the guard rule ${ctx.rule} needs a human`;
  }
  const text = normalizeText([ctx.command, ...ctx.paths.map((p) => resolve(p))].join("\n"));
  const home = resolve(ctx.harnessHome).toLowerCase();
  if (text.includes(home) || text.includes(basename(home))) {
    return "the action touches the harness home";
  }
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

function contextFor(
  db: Database,
  approval: ApprovalRow,
  managerMemberId: string,
  harnessHome: string,
): DecideContext {
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
    rule: str(field(approval.l1, "rule")) || null,
    kind: str(field(approval.action, "kind")),
    command: str(field(approval.action, "command")),
    paths: Array.isArray(paths) ? paths.map(str) : [],
    harnessHome,
  };
}

export function decidableApprovals(
  db: Database,
  managerMemberId: string,
  harnessHome: string,
): ApprovalRow[] {
  const now = Date.now();
  return listApprovals(db, "pending").filter(
    (a) =>
      a.expiresAt > now &&
      managerMayDecide(contextFor(db, a, managerMemberId, harnessHome)) === null,
  );
}

export function managerDecide(
  db: Database,
  input: {
    approvalId: string;
    managerMemberId: string;
    harnessHome: string;
    decision: "approve" | "deny";
    reason: string;
  },
): { ok: true } | { ok: false; reason: string } {
  const approval = getApproval(db, input.approvalId);
  if (!approval) return { ok: false, reason: "unknown approval" };
  const ctx = contextFor(db, approval, input.managerMemberId, input.harnessHome);
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
