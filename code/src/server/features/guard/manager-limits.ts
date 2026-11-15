import type { Database } from "bun:sqlite";
import { basename, posix, resolve } from "node:path";
import { appendEvent } from "../logs/api";
import { getMember, getProject, managerPositionsOf, reportsTransitivelyTo } from "../orgs/api";
import { type ApprovalRow, decideApproval, getApproval, listApprovals } from "./approvals";
import { type AutonomyView, autonomyOfRun } from "./autonomy";
import { DENY_EXFILTRATION } from "./l2";

interface ActionContext {
  category: string | null;
  rule: string | null;
  kind: string;
  command: string;
  paths: string[];
  harnessHome: string;
  exfiltration: number;
}

export interface DecideContext extends ActionContext {
  requesterMemberId: string | null;
  managerMemberId: string;
  inSubtree: boolean;
  // False when the run works in a project owned by another org than the manager's.
  ownsProject: boolean;
  // Anything but full autonomy keeps the decision with a human.
  autonomy: AutonomyView | null;
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
  "accounts/",
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

// Quoting, escapes, globs, expansions and `cd` change what actually runs after the guard looked
// at the text, so a human must read those commands.
const SHELL_INDIRECTION = /['"\\*?[\]{}$`]|(^|[\s;&|(])cd\s/;

// What only the instance admin may wave through, whoever else asks: a manager agent or a human
// who administers an org. Such an org can be anyone's personal org, so it earns no host trust.
function actionRefusal(ctx: ActionContext): string | null {
  if (ctx.category === "network" || ctx.category === "secret" || ctx.kind === "fetch") {
    return "network and secret actions need a human";
  }
  if (ctx.exfiltration >= DENY_EXFILTRATION) return "laya flagged possible exfiltration";
  if (ctx.rule !== null && (ctx.rule.endsWith(".outside-root") || BLIND_RULES.includes(ctx.rule))) {
    return `the guard rule ${ctx.rule} needs a human`;
  }
  if (SHELL_INDIRECTION.test(ctx.command)) {
    return "command uses shell indirection; a human must decide";
  }
  const text = normalizeText([ctx.command, ...ctx.paths.map((p) => resolve(p))].join("\n"));
  const home = resolve(ctx.harnessHome).toLowerCase();
  if (text.includes(home) || text.includes(basename(home))) {
    return "the action touches the harness home";
  }
  const hit = FORBIDDEN.find((word) => text.includes(word));
  return hit === undefined ? null : `the action mentions ${hit}`;
}

export function managerMayDecide(ctx: DecideContext): string | null {
  if (ctx.requesterMemberId === null) return "the run has no member";
  if (ctx.requesterMemberId === ctx.managerMemberId)
    return "managers cannot decide their own request";
  if (!ctx.inSubtree) return "the requester does not report to you";
  if (!ctx.ownsProject) return "the run works on another org's project; a human must decide";
  if (ctx.autonomy && ctx.autonomy.value !== "full") {
    return `autonomy is ${ctx.autonomy.value} (${ctx.autonomy.layer})`;
  }
  return actionRefusal(ctx);
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

function exfiltrationOf(l2: string | null): number {
  const probs = field(l2, "probs");
  const score =
    typeof probs === "object" && probs !== null
      ? (probs as Record<string, unknown>).exfiltration
      : 0;
  return typeof score === "number" ? score : 0;
}

function actionContext(approval: ApprovalRow, harnessHome: string): ActionContext {
  const paths = field(approval.action, "paths");
  return {
    category: str(field(approval.l1, "category")) || null,
    rule: str(field(approval.l1, "rule")) || null,
    kind: str(field(approval.action, "kind")),
    command: str(field(approval.action, "command")),
    paths: Array.isArray(paths) ? paths.map(str) : [],
    harnessHome,
    exfiltration: exfiltrationOf(approval.l2),
  };
}

export function orgAdminRefusal(approval: ApprovalRow, harnessHome: string): string | null {
  return actionRefusal(actionContext(approval, harnessHome));
}

function contextFor(
  db: Database,
  approval: ApprovalRow,
  managerMemberId: string,
  harnessHome: string,
): DecideContext {
  const run = db
    .query<{ member_id: string | null; project_id: string | null }, [string]>(
      "SELECT member_id, project_id FROM runs WHERE id = ?",
    )
    .get(approval.runId);
  const requesterMemberId = run?.member_id ?? null;
  const requester = requesterMemberId === null ? null : getMember(db, requesterMemberId);
  const inSubtree =
    requester !== null &&
    managerPositionsOf(db, managerMemberId).some(
      (p) => p.orgId === requester.orgId && reportsTransitivelyTo(db, requester.id, p.id),
    );
  // A grantee org's manager may lead the requester, yet the project and its repo are the owner's.
  const projectOrgId = run?.project_id ? (getProject(db, run.project_id)?.orgId ?? null) : null;
  const ownsProject =
    !run?.project_id ||
    (projectOrgId !== null && projectOrgId === getMember(db, managerMemberId)?.orgId);
  return {
    ...actionContext(approval, harnessHome),
    requesterMemberId,
    managerMemberId,
    inSubtree,
    ownsProject,
    autonomy: autonomyOfRun(db, approval.runId),
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
