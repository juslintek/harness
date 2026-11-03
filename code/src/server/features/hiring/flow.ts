import type { Database } from "bun:sqlite";
import { DomainError } from "../../route-kit";
import { getMember, roleAtLeast } from "../orgs/api";
import { effective } from "../policies/api";
import { approverOf, clock, decide, type HiringDeps } from "./hire";
import {
  baseQuestionIdByBody,
  CARD_QUESTION,
  getQuestion,
  insertAnswer,
  insertQuestion,
  insertReviewer,
  markAsked,
  questionProgress,
  questionsOf,
  reviewersOf,
  scorecardsOf,
  upsertScorecard,
} from "./interview-repo";
import {
  type CandidateRow,
  candidatesOf,
  getCandidate,
  getHead,
  type HireHead,
  setCandidateStatus,
  setStatus,
  teamMemberIds,
} from "./repo";
import { computeTotals } from "./score";

const PHASE_MS = 20 * 60 * 1000;
const MAX_REVIEWERS = 2;
const MAX_STEPS = 6;

const live = (cs: CandidateRow[]): CandidateRow[] => cs.filter((c) => c.status !== "failed");

function wakeReviewers(db: Database, deps: HiringDeps, head: HireHead, phase: string): void {
  for (const r of reviewersOf(db, head.id)) {
    deps.wake(r.memberId, "hire_review", { requestId: head.id, phase }, `hire:${head.id}`);
  }
}

// The requester knows the role best, so it reviews first when it is an agent of the team.
function inviteReviewers(db: Database, head: HireHead): void {
  const agents = teamMemberIds(db, head.teamId).filter((id) => {
    const m = getMember(db, id);
    return m?.kind === "agent" && m.role === "member" && !m.paused;
  });
  const ordered = [
    ...agents.filter((id) => id === head.requestedBy),
    ...agents.filter((id) => id !== head.requestedBy),
  ];
  for (const id of ordered.slice(0, MAX_REVIEWERS)) insertReviewer(db, head.id, id);
}

function enterFollowups(db: Database, deps: HiringDeps, head: HireHead): void {
  setStatus(db, head.id, "followups", clock(deps));
  inviteReviewers(db, head);
  wakeReviewers(db, deps, head, "followups");
}

function enterAnswering(db: Database, deps: HiringDeps, head: HireHead): void {
  setStatus(db, head.id, "answering", clock(deps));
  const followups = questionsOf(db, head.id).filter((q) => q.kind === "followup");
  for (const c of live(candidatesOf(db, head.id))) {
    const ids = followups.filter((q) => q.candidateId === c.id).map((q) => q.id);
    if (ids.length === 0) continue;
    setCandidateStatus(db, c.id, "interviewing");
    deps.startInterview(c.id, ids);
  }
}

function enterScoring(db: Database, deps: HiringDeps, head: HireHead): void {
  setStatus(db, head.id, "scoring", clock(deps));
  wakeReviewers(db, deps, head, "scoring");
}

function enterDeciding(db: Database, deps: HiringDeps, head: HireHead): void {
  computeTotals(db, deps, head);
  setStatus(db, head.id, "deciding", clock(deps));
  const ctx = { orgId: head.orgId, teamId: head.teamId };
  const mode = effective(db, ctx, "hiring.decision").value;
  if (mode === "auto") {
    const min = effective(db, ctx, "hiring.autoMinScore").value;
    const best = live(candidatesOf(db, head.id))
      .filter((c) => c.total !== null)
      .sort((a, b) => (b.total ?? 0) - (a.total ?? 0))[0];
    const hit = best && (best.total ?? 0) >= min ? best : null;
    decide(db, deps, {
      requestId: head.id,
      candidateId: hit?.id ?? null,
      decidedBy: "policy:auto",
      reason: hit
        ? `best total ${hit.total?.toFixed(2)} reached ${min}`
        : `no candidate reached ${min}`,
    });
  } else if (mode === "manager") {
    const approver = approverOf(db, head);
    if (approver) deps.wake(approver, "hire_decision", { requestId: head.id }, `hire:${head.id}`);
  }
}

function stepInterviewing(db: Database, deps: HiringDeps, head: HireHead, stale: boolean): boolean {
  if (stale) {
    for (const c of candidatesOf(db, head.id)) {
      if (c.status === "pending" || c.status === "interviewing")
        setCandidateStatus(db, c.id, "failed");
    }
  }
  const cands = candidatesOf(db, head.id);
  if (!cands.every((c) => c.status === "answered" || c.status === "failed")) return false;
  if (live(cands).length === 0) {
    setStatus(db, head.id, "deciding", clock(deps));
    decide(db, deps, {
      requestId: head.id,
      candidateId: null,
      decidedBy: "harness",
      reason: "no candidate answered",
    });
    return false;
  }
  enterFollowups(db, deps, head);
  return true;
}

function stepFollowups(db: Database, deps: HiringDeps, head: HireHead, stale: boolean): boolean {
  if (!stale && !reviewersOf(db, head.id).every((r) => r.asked)) return false;
  const asked = questionsOf(db, head.id).some((q) => q.kind === "followup");
  (asked ? enterAnswering : enterScoring)(db, deps, head);
  return true;
}

function stepAnswering(db: Database, deps: HiringDeps, head: HireHead, stale: boolean): boolean {
  if (!stale && !live(candidatesOf(db, head.id)).every((c) => c.status === "answered"))
    return false;
  enterScoring(db, deps, head);
  return true;
}

function stepScoring(db: Database, deps: HiringDeps, head: HireHead, stale: boolean): boolean {
  const cands = live(candidatesOf(db, head.id));
  const scored = reviewersOf(db, head.id).every((r) =>
    cands.every((c) => scorecardsOf(db, c.id).some((s) => s.scorerId === r.memberId)),
  );
  if (!stale && !scored) return false;
  enterDeciding(db, deps, head);
  return false;
}

const steps = {
  interviewing: stepInterviewing,
  followups: stepFollowups,
  answering: stepAnswering,
  scoring: stepScoring,
} as const;

export function advance(db: Database, deps: HiringDeps, requestId: string): void {
  for (let i = 0; i < MAX_STEPS; i++) {
    const head = getHead(db, requestId);
    const step = head && head.status in steps ? steps[head.status as keyof typeof steps] : null;
    if (!head || !step) return;
    const stale = clock(deps) - head.phaseStartedAt > PHASE_MS;
    if (!step(db, deps, head, stale)) return;
  }
}

export function recordAnswer(
  db: Database,
  candidateId: string,
  questionId: string,
  body: string,
  runId: string | null,
): string {
  const cand = getCandidate(db, candidateId);
  const question = getQuestion(db, questionId);
  const head = cand ? getHead(db, cand.requestId) : null;
  if (!cand || !head || !question || question.requestId !== head.id)
    throw new DomainError("unknown question");
  if (question.candidateId !== null && question.candidateId !== cand.id) {
    throw new DomainError("question is for another candidate");
  }
  if (cand.status === "failed" || (head.status !== "interviewing" && head.status !== "answering")) {
    throw new DomainError("interview is closed");
  }
  insertAnswer(db, { questionId, candidateId, body, runId, now: Date.now() });
  const { total, answered } = questionProgress(db, head.id, cand.id);
  if (answered === total) setCandidateStatus(db, cand.id, "answered");
  return head.id;
}

// A candidate who submits the card never calls interview_answer for that question, so the submit counts as its answer.
export function recordCardAnswer(db: Database, candidateId: string, runId: string | null): void {
  const cand = getCandidate(db, candidateId);
  const head = cand ? getHead(db, cand.requestId) : null;
  if (!cand || !head || (head.status !== "interviewing" && head.status !== "answering")) return;
  const questionId = baseQuestionIdByBody(db, head.id, CARD_QUESTION);
  if (questionId) recordAnswer(db, candidateId, questionId, "card submitted", runId);
}

// While answering follow-ups a clean exit with some answers still counts; otherwise unanswered questions mean the candidate failed.
export function candidateRunEnded(
  db: Database,
  deps: HiringDeps,
  candidateId: string,
  ok: boolean,
): void {
  const cand = getCandidate(db, candidateId);
  const head = cand ? getHead(db, cand.requestId) : null;
  if (!cand || !head || (head.status !== "interviewing" && head.status !== "answering")) return;
  const { total, answered } = questionProgress(db, head.id, cand.id);
  const partialOk = head.status === "answering" && ok && answered > 0;
  setCandidateStatus(db, cand.id, answered === total || partialOk ? "answered" : "failed");
  advance(db, deps, head.id);
}

function invitedReviewer(db: Database, head: HireHead, memberId: string): void {
  if (!reviewersOf(db, head.id).some((r) => r.memberId === memberId)) {
    throw new DomainError("not a reviewer of this request");
  }
}

export interface AskInput {
  requestId: string;
  reviewerId: string;
  candidateId: string;
  body: string;
}

export function ask(db: Database, deps: HiringDeps, input: AskInput): string {
  const head = getHead(db, input.requestId);
  if (head?.status !== "followups") throw new DomainError("follow-ups are not open");
  invitedReviewer(db, head, input.reviewerId);
  const cands = live(candidatesOf(db, head.id));
  if (!cands.some((c) => c.id === input.candidateId)) throw new DomainError("unknown candidate");
  const body = input.body.trim();
  if (body.length === 0 || body.length > 1000)
    throw new DomainError("question must be 1 to 1000 characters");
  const mine = questionsOf(db, head.id).filter(
    (q) => q.kind === "followup" && q.askedBy === input.reviewerId,
  );
  if (mine.some((q) => q.candidateId === input.candidateId))
    throw new DomainError("already asked this candidate");
  const id = insertQuestion(db, {
    requestId: head.id,
    candidateId: input.candidateId,
    askedBy: input.reviewerId,
    kind: "followup",
    body,
    now: clock(deps),
  });
  if (cands.every((c) => c.id === input.candidateId || mine.some((q) => q.candidateId === c.id))) {
    markAsked(db, head.id, input.reviewerId);
  }
  advance(db, deps, head.id);
  return id;
}

export function pass(db: Database, deps: HiringDeps, requestId: string, reviewerId: string): void {
  const head = getHead(db, requestId);
  if (head?.status !== "followups") throw new DomainError("follow-ups are not open");
  invitedReviewer(db, head, reviewerId);
  markAsked(db, requestId, reviewerId);
  advance(db, deps, requestId);
}

export interface ScoreInput {
  candidateId: string;
  scorerId: string;
  fit: number;
  depth: number;
  honesty: number;
  notes: string;
}

export function score(db: Database, deps: HiringDeps, input: ScoreInput): void {
  const cand = getCandidate(db, input.candidateId);
  const head = cand ? getHead(db, cand.requestId) : null;
  if (!cand || !head || head.status !== "scoring" || cand.status === "failed") {
    throw new DomainError("candidate cannot be scored now");
  }
  const scorer = getMember(db, input.scorerId);
  const invited = reviewersOf(db, head.id).some((r) => r.memberId === input.scorerId);
  const admin =
    scorer?.orgId === head.orgId && scorer.kind === "human" && roleAtLeast(scorer.role, "admin");
  if (!invited && !admin) throw new DomainError("not allowed to score this request");
  for (const v of [input.fit, input.depth, input.honesty]) {
    if (!Number.isInteger(v) || v < 1 || v > 5)
      throw new DomainError("scores are integers from 1 to 5");
  }
  upsertScorecard(db, { ...input, now: clock(deps) });
  advance(db, deps, head.id);
}
