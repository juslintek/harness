import type { Database } from "bun:sqlite";
import type { HireView, RoleSpec } from "../../../shared/hiring";
import type { Engine } from "../../../shared/router";
import { DomainError } from "../../route-kit";
import {
  addAgentMember,
  addToTeam,
  createPosition,
  findMemberByHandle,
  getMember,
  listPositions,
  listTeams,
  managerPositionsOf,
  type PositionRow,
} from "../orgs/api";
import { effective } from "../policies/api";
import { attachProfile, createProfile, getProfile } from "../profiles/api";
import { insertQuestion } from "./interview-repo";
import { onboardingPack } from "./onboarding";
import {
  candidatesOf,
  getCandidate,
  getHead,
  getHire,
  type HireHead,
  insertCandidate,
  insertRequest,
  setCandidateStatus,
} from "./repo";

type WakeReason = "hire_review" | "hire_decision" | "onboarding" | "approval_resolved";

export interface HiringDeps {
  // Distinct runtimes, best first; the router decides what best means.
  pickEngines(input: { orgId: string; teamId: string; spec: RoleSpec; max: number }): Engine[];
  engineReady(engine: Engine): boolean;
  startInterview(candidateId: string, questionIds: string[]): void;
  wake(memberId: string, reason: WakeReason, detail: object, causedBy: string): void;
  now?: () => number;
}

export const clock = (deps: HiringDeps): number => deps.now?.() ?? Date.now();

export interface FileInput {
  orgId: string;
  teamId: string;
  requestedBy: string;
  spec: RoleSpec;
  maxCandidates?: number;
}

function baseQuestions(spec: RoleSpec): string[] {
  const strengths = spec.mustHave.length > 0 ? spec.mustHave.join(", ") : spec.specialty;
  return [
    `In at most 120 words, how would you approach: ${spec.summary}?`,
    `Which of these are you strong or weak at, honestly: ${strengths}?`,
    "Submit your self-description card with profile_card_submit.",
  ];
}

function pickAllowed(db: Database, deps: HiringDeps, input: FileInput, max: number): Engine[] {
  const allowed = effective(
    db,
    { orgId: input.orgId, teamId: input.teamId },
    "router.allowedRuntimes",
  ).value;
  const picked: Engine[] = [];
  for (const e of deps.pickEngines({
    orgId: input.orgId,
    teamId: input.teamId,
    spec: input.spec,
    max,
  })) {
    const permitted = allowed === null || allowed.includes(e.runtime);
    if (permitted && !picked.some((p) => p.runtime === e.runtime)) picked.push(e);
  }
  return picked.slice(0, max);
}

export function fileRequest(db: Database, deps: HiringDeps, input: FileInput): HireView {
  if (!listTeams(db, input.orgId).some((t) => t.id === input.teamId)) {
    throw new DomainError("unknown team");
  }
  const engines = pickAllowed(db, deps, input, input.maxCandidates ?? 2);
  if (engines.length === 0) throw new DomainError("no engine is available for this role");
  const { spec } = input;
  const persona = `You are a ${spec.title}. Focus: ${spec.summary}. Must have: ${spec.mustHave.join(", ")}.`;
  const now = clock(deps);
  const { requestId, candidateIds, questionIds } = db.transaction(() => {
    const requestId = insertRequest(db, { ...input, now });
    const candidateIds = engines.map((engine) => {
      const profile = createProfile(db, input.orgId, {
        runtime: engine.runtime,
        model: engine.model,
        persona,
        skills: [],
        scope: { readOnly: true },
        fallbacks: [],
      });
      return insertCandidate(db, requestId, profile.id);
    });
    const questionIds = baseQuestions(spec).map((body) =>
      insertQuestion(db, { requestId, candidateId: null, askedBy: null, kind: "base", body, now }),
    );
    return { requestId, candidateIds, questionIds };
  })();
  for (const id of candidateIds) {
    setCandidateStatus(db, id, "interviewing");
    deps.startInterview(id, questionIds);
  }
  return getHire(db, requestId) as HireView;
}

function teamManagerPosition(db: Database, head: HireHead): PositionRow | null {
  return listPositions(db, head.orgId).find((p) => p.teamId === head.teamId && p.isManager) ?? null;
}

// A manager asking for help is answered by their own manager; anyone else by the team's manager.
export function approverOf(db: Database, head: HireHead): string | null {
  const held = managerPositionsOf(db, head.requestedBy).find((p) => p.teamId === head.teamId);
  const target = held
    ? listPositions(db, head.orgId).find((p) => p.id === held.reportsTo)
    : teamManagerPosition(db, head);
  const holder = target?.memberId ? getMember(db, target.memberId) : null;
  return holder?.kind === "agent" ? holder.id : null;
}

function uniqueHandle(db: Database, orgId: string, title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  const stem = base.length >= 2 ? base : "agent";
  for (let n = 1; ; n++) {
    const handle = n === 1 ? stem : `${stem}-${n}`;
    if (!findMemberByHandle(db, orgId, handle)) return handle;
  }
}

function createHired(db: Database, head: HireHead, profileId: string): string {
  const profile = getProfile(db, profileId);
  if (!profile) throw new Error("candidate profile is gone");
  const { spec } = head;
  const member = addAgentMember(db, head.orgId, {
    agentId: profile.runtime,
    ...(profile.model ? { model: profile.model } : {}),
    handle: uniqueHandle(db, head.orgId, spec.title),
    displayName: spec.title,
    specialties: [...new Set([spec.specialty, ...(profile.card?.specialties ?? [])])],
  });
  attachProfile(db, member.id, profileId);
  addToTeam(db, head.teamId, member.id);
  const manager =
    managerPositionsOf(db, head.requestedBy).find((p) => p.teamId === head.teamId) ??
    teamManagerPosition(db, head);
  createPosition(db, {
    orgId: head.orgId,
    teamId: head.teamId,
    title: spec.title,
    memberId: member.id,
    ...(manager ? { reportsTo: manager.id } : {}),
  });
  return member.id;
}

export type DecideResult = { ok: true; memberId?: string } | { ok: false; reason: string };

export interface DecideInput {
  requestId: string;
  candidateId: string | null;
  decidedBy: string;
  reason: string;
}

function settle(db: Database, head: HireHead, input: DecideInput, now: number): string | null {
  const status = input.candidateId === null ? "rejected" : "hired";
  const flipped = db
    .query(
      `UPDATE hire_requests SET status = ?, decided_by = ?, decision_reason = ?, updated_at = ?
       WHERE id = ? AND status = 'deciding'`,
    )
    .run(status, input.decidedBy, input.reason, now, head.id).changes;
  if (flipped === 0) throw new DomainError("already decided");
  const chosen = candidatesOf(db, head.id).find((c) => c.id === input.candidateId);
  for (const c of candidatesOf(db, head.id)) {
    if (c.status !== "failed") setCandidateStatus(db, c.id, c === chosen ? "hired" : "rejected");
  }
  if (!chosen) return null;
  const memberId = createHired(db, head, chosen.profileId);
  const pack = onboardingPack(db, memberId, head);
  db.query("UPDATE hire_requests SET hired_member_id = ?, onboarding = ? WHERE id = ?").run(
    memberId,
    pack,
    head.id,
  );
  return memberId;
}

function notify(db: Database, deps: HiringDeps, head: HireHead, memberId: string | null): void {
  const cause = `hire:${head.id}`;
  if (memberId) deps.wake(memberId, "onboarding", { requestId: head.id }, cause);
  if (getMember(db, head.requestedBy)?.kind === "agent") {
    const outcome = memberId ? "hired" : "rejected";
    deps.wake(
      head.requestedBy,
      "approval_resolved",
      { kind: "hire", requestId: head.id, outcome },
      cause,
    );
  }
}

export function decide(db: Database, deps: HiringDeps, input: DecideInput): DecideResult {
  const head = getHead(db, input.requestId);
  if (!head) return { ok: false, reason: "unknown request" };
  const chosen = input.candidateId ? getCandidate(db, input.candidateId) : null;
  if (input.candidateId && (chosen?.requestId !== head.id || chosen.status === "failed")) {
    return { ok: false, reason: "unknown candidate" };
  }
  if (head.status !== "deciding") {
    const open =
      head.status !== "hired" && head.status !== "rejected" && head.status !== "cancelled";
    return { ok: false, reason: open ? "not ready to decide" : "already decided" };
  }
  try {
    const memberId = db.transaction(() => settle(db, head, input, clock(deps)))();
    notify(db, deps, head, memberId);
    return memberId ? { ok: true, memberId } : { ok: true };
  } catch (err) {
    if (err instanceof DomainError) return { ok: false, reason: err.message };
    throw err;
  }
}
