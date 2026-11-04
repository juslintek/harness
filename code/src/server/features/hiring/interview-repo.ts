import type { Database } from "bun:sqlite";
import type { InterviewAnswer, InterviewQuestion, Scorecard } from "../../../shared/hiring";

type Raw = Record<string, string | number | null>;

// The card is submitted through its own tool, so its question is found by this text.
export const CARD_QUESTION = "Submit your self-description card with profile_card_submit.";

export function insertQuestion(
  db: Database,
  q: {
    requestId: string;
    candidateId: string | null;
    askedBy: string | null;
    kind: "base" | "followup";
    body: string;
    now: number;
  },
): string {
  const id = Bun.randomUUIDv7();
  db.query(
    `INSERT INTO interview_questions (id, request_id, candidate_id, asked_by, kind, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, q.requestId, q.candidateId, q.askedBy, q.kind, q.body, q.now);
  return id;
}

const question = (r: Raw): InterviewQuestion => ({
  id: r.id as string,
  candidateId: r.candidate_id as string | null,
  askedBy: r.asked_by as string | null,
  kind: r.kind as "base" | "followup",
  body: r.body as string,
  createdAt: r.created_at as number,
});

export function questionsOf(db: Database, requestId: string): InterviewQuestion[] {
  return db
    .query<Raw, [string]>("SELECT * FROM interview_questions WHERE request_id = ? ORDER BY rowid")
    .all(requestId)
    .map(question);
}

export function getQuestion(
  db: Database,
  id: string,
): (InterviewQuestion & { requestId: string }) | null {
  const r = db.query<Raw, [string]>("SELECT * FROM interview_questions WHERE id = ?").get(id);
  return r ? { ...question(r), requestId: r.request_id as string } : null;
}

export function baseQuestionIdByBody(db: Database, requestId: string, body: string): string | null {
  const r = db
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM interview_questions WHERE request_id = ? AND kind = 'base' AND body = ?",
    )
    .get(requestId, body);
  return r?.id ?? null;
}

export function questionProgress(
  db: Database,
  requestId: string,
  candidateId: string,
  kind: "base" | "followup" | null = null,
): { total: number; answered: number } {
  return db
    .query<
      { total: number; answered: number },
      [string, string, string, string | null, string | null]
    >(
      `SELECT COUNT(*) AS total, COUNT(a.question_id) AS answered
       FROM interview_questions q
       LEFT JOIN interview_answers a ON a.question_id = q.id AND a.candidate_id = ?
       WHERE q.request_id = ? AND (q.candidate_id IS NULL OR q.candidate_id = ?)
         AND (? IS NULL OR q.kind = ?)`,
    )
    .get(candidateId, requestId, candidateId, kind, kind) as { total: number; answered: number };
}

export function insertAnswer(
  db: Database,
  a: { questionId: string; candidateId: string; body: string; runId: string | null; now: number },
): void {
  db.query(
    `INSERT OR IGNORE INTO interview_answers (question_id, candidate_id, body, run_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(a.questionId, a.candidateId, a.body, a.runId, a.now);
}

export function answersOf(db: Database, candidateId: string): InterviewAnswer[] {
  return db
    .query<Raw, [string]>(
      "SELECT * FROM interview_answers WHERE candidate_id = ? ORDER BY created_at, rowid",
    )
    .all(candidateId)
    .map((r) => ({
      questionId: r.question_id as string,
      body: r.body as string,
      runId: r.run_id as string | null,
      createdAt: r.created_at as number,
    }));
}

export function insertReviewer(db: Database, requestId: string, memberId: string): void {
  db.query("INSERT OR IGNORE INTO hire_reviewers (request_id, member_id) VALUES (?, ?)").run(
    requestId,
    memberId,
  );
}

export function reviewersOf(
  db: Database,
  requestId: string,
): { memberId: string; asked: boolean }[] {
  return db
    .query<{ member_id: string; asked: number }, [string]>(
      "SELECT member_id, asked FROM hire_reviewers WHERE request_id = ? ORDER BY rowid",
    )
    .all(requestId)
    .map((r) => ({ memberId: r.member_id, asked: r.asked === 1 }));
}

export function markAsked(db: Database, requestId: string, memberId: string): void {
  db.query("UPDATE hire_reviewers SET asked = 1 WHERE request_id = ? AND member_id = ?").run(
    requestId,
    memberId,
  );
}

export function upsertScorecard(
  db: Database,
  s: {
    candidateId: string;
    scorerId: string;
    fit: number;
    depth: number;
    honesty: number;
    notes: string;
    now: number;
  },
): void {
  db.query(
    `INSERT INTO scorecards (candidate_id, scorer_id, fit, depth, honesty, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (candidate_id, scorer_id) DO UPDATE SET
       fit = excluded.fit, depth = excluded.depth, honesty = excluded.honesty,
       notes = excluded.notes, created_at = excluded.created_at`,
  ).run(s.candidateId, s.scorerId, s.fit, s.depth, s.honesty, s.notes, s.now);
}

export function scorecardsOf(db: Database, candidateId: string): Scorecard[] {
  return db
    .query<Raw, [string]>(
      "SELECT * FROM scorecards WHERE candidate_id = ? ORDER BY created_at, scorer_id",
    )
    .all(candidateId)
    .map((r) => ({
      scorerId: r.scorer_id as string,
      fit: r.fit as number,
      depth: r.depth as number,
      honesty: r.honesty as number,
      notes: r.notes as string,
      createdAt: r.created_at as number,
    }));
}
