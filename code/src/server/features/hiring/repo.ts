import type { Database } from "bun:sqlite";
import type { CandidateStatus, HireStatus, HireView, RoleSpec } from "../../../shared/hiring";
import { getProfile } from "../profiles/api";
import { answersOf, questionsOf, reviewersOf, scorecardsOf } from "./interview-repo";

export type HireHead = Omit<HireView, "candidates" | "questions" | "reviewers">;
export interface CandidateRow {
  id: string;
  requestId: string;
  profileId: string;
  status: CandidateStatus;
  systemScore: number | null;
  total: number | null;
}

type Raw = Record<string, string | number | null>;

const head = (r: Raw): HireHead => ({
  id: r.id as string,
  orgId: r.org_id as string,
  teamId: r.team_id as string,
  requestedBy: r.requested_by as string,
  spec: JSON.parse(r.spec as string) as RoleSpec,
  status: r.status as HireStatus,
  phaseStartedAt: r.phase_started_at as number,
  decidedBy: r.decided_by as string | null,
  decisionReason: r.decision_reason as string | null,
  hiredMemberId: r.hired_member_id as string | null,
  onboarding: r.onboarding as string | null,
  createdAt: r.created_at as number,
});

const candidate = (r: Raw): CandidateRow => ({
  id: r.id as string,
  requestId: r.request_id as string,
  profileId: r.profile_id as string,
  status: r.status as CandidateStatus,
  systemScore: r.system_score as number | null,
  total: r.total as number | null,
});

export function getHead(db: Database, id: string): HireHead | null {
  const r = db.query<Raw, [string]>("SELECT * FROM hire_requests WHERE id = ?").get(id);
  return r ? head(r) : null;
}

export function listHeads(db: Database, orgId: string): HireHead[] {
  return db
    .query<Raw, [string]>(
      "SELECT * FROM hire_requests WHERE org_id = ? ORDER BY created_at DESC, id",
    )
    .all(orgId)
    .map(head);
}

export function openRequestIds(db: Database): string[] {
  return db
    .query<{ id: string }, []>(
      "SELECT id FROM hire_requests WHERE status IN ('interviewing', 'followups', 'answering', 'scoring', 'deciding')",
    )
    .all()
    .map((r) => r.id);
}

export function insertRequest(
  db: Database,
  input: { orgId: string; teamId: string; requestedBy: string; spec: RoleSpec; now: number },
): string {
  const id = Bun.randomUUIDv7();
  db.query(
    `INSERT INTO hire_requests (id, org_id, team_id, requested_by, spec, status, phase_started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'interviewing', ?, ?, ?)`,
  ).run(
    id,
    input.orgId,
    input.teamId,
    input.requestedBy,
    JSON.stringify(input.spec),
    input.now,
    input.now,
    input.now,
  );
  return id;
}

export function setStatus(db: Database, id: string, status: HireStatus, now: number): void {
  db.query(
    "UPDATE hire_requests SET status = ?, phase_started_at = ?, updated_at = ? WHERE id = ?",
  ).run(status, now, now, id);
}

export function insertCandidate(db: Database, requestId: string, profileId: string): string {
  const id = Bun.randomUUIDv7();
  db.query(
    "INSERT INTO hire_candidates (id, request_id, profile_id, status) VALUES (?, ?, ?, 'pending')",
  ).run(id, requestId, profileId);
  return id;
}

export function candidatesOf(db: Database, requestId: string): CandidateRow[] {
  return db
    .query<Raw, [string]>("SELECT * FROM hire_candidates WHERE request_id = ? ORDER BY rowid")
    .all(requestId)
    .map(candidate);
}

export function getCandidate(db: Database, id: string): CandidateRow | null {
  const r = db.query<Raw, [string]>("SELECT * FROM hire_candidates WHERE id = ?").get(id);
  return r ? candidate(r) : null;
}

export function setCandidateStatus(db: Database, id: string, status: CandidateStatus): void {
  db.query("UPDATE hire_candidates SET status = ? WHERE id = ?").run(status, id);
}

export function setCandidateScores(
  db: Database,
  id: string,
  systemScore: number,
  total: number,
): void {
  db.query("UPDATE hire_candidates SET system_score = ?, total = ? WHERE id = ?").run(
    systemScore,
    total,
    id,
  );
}

export function candidateOfRun(db: Database, runId: string): string | null {
  const row = db
    .query<{ candidate_id: string }, [string]>(
      "SELECT candidate_id FROM run_tokens WHERE run_id = ? AND candidate_id IS NOT NULL LIMIT 1",
    )
    .get(runId);
  return row?.candidate_id ?? null;
}

export function getHire(db: Database, id: string): HireView | null {
  const h = getHead(db, id);
  if (!h) return null;
  const candidates = candidatesOf(db, id).flatMap((c) => {
    const profile = getProfile(db, c.profileId);
    return profile
      ? [
          {
            id: c.id,
            status: c.status,
            systemScore: c.systemScore,
            total: c.total,
            profile,
            answers: answersOf(db, c.id),
            scorecards: scorecardsOf(db, c.id),
          },
        ]
      : [];
  });
  return { ...h, candidates, questions: questionsOf(db, id), reviewers: reviewersOf(db, id) };
}

// Reads the org slice's team_members directly, like policies/repo.ts does; orgs/api has no listing.
export function teamMemberIds(db: Database, teamId: string): string[] {
  return db
    .query<{ id: string }, [string]>(
      `SELECT m.id FROM team_members tm JOIN members m ON m.id = tm.member_id
       WHERE tm.team_id = ? ORDER BY m.created_at, m.id`,
    )
    .all(teamId)
    .map((r) => r.id);
}

export function teamHasSpecialty(db: Database, teamId: string, specialty: string): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM team_members tm JOIN members m ON m.id = tm.member_id, json_each(m.specialties) s
         WHERE tm.team_id = ? AND s.value = ? LIMIT 1`,
      )
      .get(teamId, specialty) !== null
  );
}
