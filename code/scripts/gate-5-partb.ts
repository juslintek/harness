import { Database } from "bun:sqlite";
import { isIP } from "node:net";
import { join } from "node:path";

export interface LiveFacts {
  server: boolean;
  pushTargetForApprover: boolean;
  pushDelivered: boolean;
  approvalApproved: boolean;
  passkeyStepUp: boolean;
  codexRunCompleted: boolean;
  phoneObservedByOperator: boolean;
}

export function missingLiveEvidence(facts: LiveFacts): string[] {
  const missing: string[] = [];
  if (!facts.server) missing.push("prepared server is not answering at HARNESS_ORIGIN");
  if (!facts.pushTargetForApprover)
    missing.push("a real push subscription for the human approver in the run org is not stored");
  if (!facts.pushDelivered)
    missing.push("the approval push has not been delivered to that human target");
  if (!facts.approvalApproved) missing.push("the selected approval has not been approved");
  if (!facts.passkeyStepUp) missing.push("a fresh passkey step-up by the approver is not recorded");
  if (!facts.codexRunCompleted) missing.push("the approval's real Codex run has not completed");
  if (!facts.phoneObservedByOperator)
    missing.push(
      "Alice has not explicitly observed phone receipt and passkey approval; after observing, rerun with --phone-observed",
    );
  return missing;
}

function realPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
      url.protocol === "https:" &&
      host !== "localhost" &&
      !host.endsWith(".localhost") &&
      !host.endsWith(".local") &&
      ![".test", ".example", ".invalid"].some((suffix) => host.endsWith(suffix)) &&
      isIP(host) === 0
    );
  } catch {
    return false;
  }
}

interface ApprovalFacts {
  run_id: string;
  run_org_id: string | null;
  agent_id: string | null;
  run_state: string | null;
  status: string;
  decided_by: string | null;
  created_at: number;
  decided_at: number | null;
}

function approvalFacts(db: Database, approvalId: string): ApprovalFacts | null {
  return db
    .query<ApprovalFacts, [string]>(
      `SELECT a.run_id, r.org_id AS run_org_id, r.agent_id, r.state AS run_state,
              a.status, a.decided_by, a.created_at, a.decided_at
         FROM approvals a LEFT JOIN runs r ON r.id = a.run_id WHERE a.id = ?`,
    )
    .get(approvalId);
}

interface PushTargetFacts {
  member_org_id: string;
  member_kind: string;
  user_id: string | null;
  value: string;
}

function pushTargetFacts(db: Database, targetId: string): PushTargetFacts | null {
  return db
    .query<PushTargetFacts, [string]>(
      `SELECT m.org_id AS member_org_id, m.kind AS member_kind, m.user_id, t.value
         FROM notify_targets t JOIN members m ON m.id = t.member_id
        WHERE t.id = ? AND t.channel = 'push'`,
    )
    .get(targetId);
}

function endpointOf(target: PushTargetFacts | null): string {
  let endpoint: string | undefined;
  try {
    endpoint = target ? (JSON.parse(target.value) as { endpoint?: string }).endpoint : undefined;
  } catch {
    endpoint = undefined;
  }
  return endpoint ?? "";
}

function deliveredTo(
  db: Database,
  targetId: string,
  approvalId: string,
  createdAt: number,
): boolean {
  return (
    db
      .query<{ id: string }, [string, string, number]>(
        `SELECT id FROM notify_log
          WHERE target_id = ? AND tag = ? AND status = 'sent' AND at >= ? LIMIT 1`,
      )
      .get(targetId, `approval:${approvalId}`, createdAt) !== null
  );
}

function hasFreshStepUp(
  db: Database,
  userId: string | null,
  approval: ApprovalFacts | null,
): boolean {
  if (!userId || approval?.decided_at === null || approval?.decided_at === undefined) return false;
  const row = db
    .query<{ step_up_at: number | null }, [string, number, number, number]>(
      `SELECT step_up_at FROM sessions
        WHERE user_id = ? AND revoked_at IS NULL AND step_up_at >= ?
          AND step_up_at <= ? AND step_up_at >= ?
        ORDER BY step_up_at DESC LIMIT 1`,
    )
    .get(userId, approval.created_at, approval.decided_at, approval.decided_at - 5 * 60_000);
  return row?.step_up_at !== null && row?.step_up_at !== undefined;
}

export function readFacts(
  db: Database,
  server: boolean,
  approvalId: string,
  targetId: string,
  phoneObservedByOperator: boolean,
): LiveFacts {
  const approval = approvalFacts(db, approvalId);
  const target = pushTargetFacts(db, targetId);
  const humanUserId = approval?.decided_by?.startsWith("user:")
    ? approval.decided_by.slice("user:".length)
    : null;
  const targetMatchesApprover =
    target?.member_kind === "human" &&
    target.user_id === humanUserId &&
    target.member_org_id === approval?.run_org_id &&
    realPushEndpoint(endpointOf(target));
  return {
    server,
    pushTargetForApprover: targetMatchesApprover,
    pushDelivered:
      targetMatchesApprover &&
      approval !== null &&
      deliveredTo(db, targetId, approvalId, approval.created_at),
    approvalApproved: approval?.status === "approved",
    passkeyStepUp: hasFreshStepUp(db, humanUserId, approval),
    codexRunCompleted: approval?.agent_id === "codex" && approval.run_state === "completed",
    phoneObservedByOperator,
  };
}

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`--live requires ${key}`);
  return value;
}

function waitSeconds(argv: string[]): number {
  const i = argv.indexOf("--wait-seconds");
  if (i === -1) return 300;
  const value = Number(argv[i + 1]);
  if (!Number.isInteger(value) || value < 0 || value > 1800) {
    throw new Error("--wait-seconds must be an integer from 0 to 1800");
  }
  return value;
}

async function serverAnswers(origin: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/api/health", origin), {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function runPartB(argv: string[] = process.argv.slice(2)): Promise<void> {
  const home = requiredEnv("HARNESS_HOME");
  const origin = requiredEnv("HARNESS_ORIGIN");
  const approvalId = requiredEnv("HARNESS_LIVE_APPROVAL_ID");
  const targetId = requiredEnv("HARNESS_LIVE_PUSH_TARGET_ID");
  const phoneObservedByOperator = argv.includes("--phone-observed");
  const seconds = waitSeconds(argv);
  const parsedOrigin = new URL(origin);
  if (
    parsedOrigin.protocol !== "https:" &&
    parsedOrigin.hostname !== "localhost" &&
    parsedOrigin.hostname !== "127.0.0.1"
  ) {
    throw new Error("HARNESS_ORIGIN must use HTTPS, except for loopback development origins");
  }

  const db = new Database(join(home, "harness.db"), { readonly: true, strict: true });
  const deadline = Date.now() + seconds * 1000;
  let missing: string[] = [];
  try {
    do {
      const facts = readFacts(
        db,
        await serverAnswers(parsedOrigin.origin),
        approvalId,
        targetId,
        phoneObservedByOperator,
      );
      missing = missingLiveEvidence(facts);
      if (missing.length === 0) break;
      if (Date.now() >= deadline) break;
      console.log(
        `Waiting for live evidence (${missing.length} outstanding): ${missing.join("; ")}`,
      );
      await Bun.sleep(5000);
    } while (Date.now() <= deadline);
  } finally {
    db.close();
  }

  if (missing.length > 0) {
    console.error(`Gate 5 Part B incomplete: ${missing.join("; ")}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    "Gate 5 Part B records are present: server, approver's push target and delivery, approved request, fresh passkey step-up, completed Codex run.",
  );
  console.log(
    "The --phone-observed value is an operator declaration. The script cannot attest physical receipt, device identity, or Touch ID hardware.",
  );
}
