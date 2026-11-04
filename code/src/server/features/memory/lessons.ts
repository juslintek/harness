import type { Database } from "bun:sqlite";
import type { LessonStatus, LessonView, NoteScope } from "../../../shared/memory";
import { getTask } from "../board/api";
import { teamIdsOf } from "../hiring/api";
import { classifyNote } from "../laya/api";
import { redact } from "../logs/api";
import { getMember, listMembers, listPositions } from "../orgs/api";
import { MemoryError } from "./store-kit";

const MIN_LESSON_CHARS = 20;
const MAX_LESSON_CHARS = 600;
const MAX_LESSONS = 3;
const CHAIN_CAP = 32;

type Raw = {
  id: string;
  task_id: string;
  org_id: string;
  project_id: string | null;
  author_id: string;
  body: string;
  scope: string;
  type: string;
  status: string;
  reviewer_id: string | null;
  reason: string | null;
  note_id: string | null;
  created_at: number;
  decided_at: number | null;
  confidence: number;
};

const view = (r: Raw): LessonView => ({
  id: r.id,
  taskId: r.task_id,
  orgId: r.org_id,
  projectId: r.project_id,
  authorId: r.author_id,
  body: r.body,
  scope: r.scope as NoteScope,
  type: "lesson",
  status: r.status as LessonStatus,
  reviewerId: r.reviewer_id,
  reason: r.reason,
  noteId: r.note_id,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

export function getLesson(db: Database, id: string): (LessonView & { confidence: number }) | null {
  const r = db.query<Raw, [string]>("SELECT * FROM lessons WHERE id = ?").get(id);
  return r ? { ...view(r), confidence: r.confidence } : null;
}

export function listLessons(db: Database, orgId: string, status?: LessonStatus): LessonView[] {
  const rows =
    status === undefined
      ? db
          .query<Raw, [string]>("SELECT * FROM lessons WHERE org_id = ? ORDER BY created_at, id")
          .all(orgId)
      : db
          .query<Raw, [string, string]>(
            "SELECT * FROM lessons WHERE org_id = ? AND status = ? ORDER BY created_at, id",
          )
          .all(orgId, status);
  return rows.map(view);
}

type ProposedListener = (e: { orgId: string; lessons: LessonView[] }) => void;
const proposed = new Set<ProposedListener>();

export function onLessonProposed(fn: ProposedListener): () => void {
  proposed.add(fn);
  return () => {
    proposed.delete(fn);
  };
}

type DecidedListener = (lesson: LessonView) => void;
const decided = new Set<DecidedListener>();

export function onLessonDecided(fn: DecidedListener): () => void {
  decided.add(fn);
  return () => {
    decided.delete(fn);
  };
}

export function emitDecided(lesson: LessonView): void {
  for (const fn of decided) {
    try {
      fn(lesson);
    } catch {
      // A broken subscriber must not undo a decision that is already stored.
    }
  }
}

// A lesson row is stored text just like a note, so a secret is cut out before either is written.
export function cleanBody(text: string): string {
  const body = redact(text).trim();
  if (body.length < MIN_LESSON_CHARS || body.length > MAX_LESSON_CHARS) {
    throw new MemoryError(
      "invalid",
      `a lesson is ${MIN_LESSON_CHARS} to ${MAX_LESSON_CHARS} characters`,
    );
  }
  return body;
}

export interface LessonCtx {
  memberId: string;
  runId: string | null;
  taskId: string;
}

function checkTask(db: Database, ctx: LessonCtx): { projectId: string; orgId: string } {
  const member = getMember(db, ctx.memberId);
  if (member?.kind !== "agent")
    throw new MemoryError("forbidden", "only an agent proposes lessons");
  const task = getTask(db, ctx.taskId);
  if (task === null || task.orgId !== member.orgId)
    throw new MemoryError("not_found", "no such task");
  if (task.assigneeId !== member.id) throw new MemoryError("forbidden", "the task is not yours");
  if (task.status !== "done") throw new MemoryError("invalid", "the task is not done yet");
  return { projectId: task.projectId, orgId: member.orgId };
}

interface Classed {
  scope: NoteScope;
  confidence: number;
}

async function classed(body: string): Promise<Classed> {
  try {
    const c = await classifyNote(body, ["project", "agent", "org"], "lesson");
    return { scope: c.scope, confidence: c.confidence };
  } catch {
    return { scope: "project", confidence: 0.5 };
  }
}

function insertAll(
  db: Database,
  ctx: LessonCtx,
  at: { projectId: string; orgId: string },
  rows: { id: string; body: string; c: Classed }[],
): void {
  const insert = db.query(
    `INSERT INTO lessons (id, task_id, org_id, project_id, author_id, run_id, body, scope, type, confidence, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'lesson', ?, 'pending', ?)`,
  );
  const now = Date.now();
  db.transaction(() => {
    // Inside the transaction so two racing calls cannot both pass: the cap is per task and author.
    const earlier = db
      .query("SELECT 1 FROM lessons WHERE task_id = ? AND author_id = ? LIMIT 1")
      .get(ctx.taskId, ctx.memberId);
    if (earlier !== null)
      throw new MemoryError("conflict", "lessons for this task were already proposed");
    for (const r of rows) {
      insert.run(
        r.id,
        ctx.taskId,
        at.orgId,
        at.projectId,
        ctx.memberId,
        ctx.runId,
        r.body,
        r.c.scope,
        r.c.confidence,
        now,
      );
    }
  })();
}

export async function proposeLessons(
  db: Database,
  ctx: LessonCtx,
  bodies: string[],
): Promise<LessonView[]> {
  if (bodies.length < 1 || bodies.length > MAX_LESSONS) {
    throw new MemoryError("invalid", `propose 1 to ${MAX_LESSONS} lessons`);
  }
  checkTask(db, ctx);
  const clean = bodies.map(cleanBody);
  const classes = await Promise.all(clean.map(classed));
  // Checked again after the await: the task may have been reopened or reassigned meanwhile.
  const at = checkTask(db, ctx);
  const rows = clean.map((body, i) => ({ id: Bun.randomUUIDv7(), body, c: classes[i] as Classed }));
  insertAll(db, ctx, at, rows);
  const lessons = rows.map((r) => getLesson(db, r.id) as LessonView);
  for (const fn of proposed) {
    try {
      fn({ orgId: at.orgId, lessons });
    } catch {
      // A broken subscriber must not undo a proposal that is already stored.
    }
  }
  return lessons;
}

function usable(db: Database, id: string, authorId: string): boolean {
  const m = getMember(db, id);
  return m?.kind === "agent" && !m.paused && m.id !== authorId;
}

// The author's manager chain first, since a manager knows what the team needs; otherwise a teammate.
export function reviewerFor(
  db: Database,
  lesson: Pick<LessonView, "authorId" | "orgId">,
): string | null {
  const positions = listPositions(db, lesson.orgId);
  const byId = new Map(positions.map((p) => [p.id, p]));
  for (const mine of positions.filter((p) => p.memberId === lesson.authorId)) {
    let up = mine.reportsTo === null ? undefined : byId.get(mine.reportsTo);
    for (let depth = 0; up !== undefined && depth < CHAIN_CAP; depth++) {
      if (up.memberId !== null && usable(db, up.memberId, lesson.authorId)) return up.memberId;
      up = up.reportsTo === null ? undefined : byId.get(up.reportsTo);
    }
  }
  const teams = new Set(teamIdsOf(db, lesson.authorId));
  const mate = listMembers(db, lesson.orgId).find(
    (m) => usable(db, m.id, lesson.authorId) && teamIdsOf(db, m.id).some((t) => teams.has(t)),
  );
  return mate?.id ?? null;
}
