import type { Database } from "bun:sqlite";
import type { LessonView } from "../../../shared/memory";
import { getTask } from "../board/api";
import { redact } from "../logs/api";
import { getMember, memberForUser } from "../orgs/api";
import { cleanBody, emitDecided, getLesson } from "./lessons";
import { diskToLocated, type Located } from "./paths";
import { createNote } from "./store";
import { MemoryError } from "./store-kit";
import { agentViewer } from "./viewer";

export interface Decider {
  memberId: string | null;
  userId: string | null;
}

const MAX_REASON = 500;
const MAX_CLASH = 50;

// An agent reviews as itself, a person as their member row in the lesson's org; the author never
// reviews their own lesson and another org's agent never reviews at all.
function reviewerOf(db: Database, lesson: LessonView, by: Decider): string {
  const m =
    by.memberId !== null
      ? getMember(db, by.memberId)
      : by.userId !== null
        ? memberForUser(db, lesson.orgId, by.userId)
        : null;
  const allowed =
    m !== null &&
    m.orgId === lesson.orgId &&
    m.id !== lesson.authorId &&
    (m.kind === "agent" ? !m.paused : m.role !== "viewer");
  if (!allowed) throw new MemoryError("forbidden", "you cannot review this lesson");
  return m.id;
}

function dirOf(lesson: LessonView): string {
  const base = `orgs/${lesson.orgId}`;
  if (lesson.scope === "project" && lesson.projectId !== null) {
    return `${base}/projects/${lesson.projectId}/lessons`;
  }
  return lesson.scope === "org"
    ? `${base}/org/lessons`
    : `${base}/agents/${lesson.authorId}/lessons`;
}

function slugOf(body: string): string {
  const words = body.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.slice(0, 6).join("-").slice(0, 60) || "lesson";
}

function claim(
  db: Database,
  id: string,
  status: "accepted" | "rejected",
  reviewerId: string,
  reason: string,
  body: string,
): void {
  const res = db
    .query(
      `UPDATE lessons SET status = ?, reviewer_id = ?, reason = ?, body = ?, decided_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(status, reviewerId, reason, body, Date.now(), id);
  if (res.changes === 0) throw new MemoryError("conflict", "already decided");
}

function release(db: Database, id: string, body: string): void {
  db.query(
    `UPDATE lessons SET status = 'pending', reviewer_id = NULL, reason = NULL, body = ?, decided_at = NULL
     WHERE id = ? AND status = 'accepted' AND note_id IS NULL`,
  ).run(body, id);
}

async function writeNote(
  db: Database,
  home: string,
  lesson: LessonView & { confidence: number },
  body: string,
): Promise<string> {
  const author = getMember(db, lesson.authorId);
  if (author === null) throw new MemoryError("not_found", "the author is gone");
  const number = getTask(db, lesson.taskId)?.number ?? 0;
  const ctx = { viewer: agentViewer(db, lesson.authorId), runId: null };
  const dir = dirOf(lesson);
  const slug = slugOf(body);
  for (let n = 1; n <= MAX_CLASH; n++) {
    const loc = diskToLocated(`${dir}/${slug}${n === 1 ? "" : `-${n}`}.md`) as Located;
    try {
      // Type and tags are given, so the note write never has to ask the classifier.
      const res = await createNote(db, home, ctx, loc, body, {
        type: "lesson",
        confidence: lesson.confidence,
        tags: ["lesson", `task-${number}`],
      });
      return res.note.id;
    } catch (e) {
      if (!(e instanceof MemoryError && e.code === "exists")) throw e;
    }
  }
  throw new MemoryError("exists", "too many lessons with the same opening words");
}

export async function decideLesson(
  db: Database,
  home: string,
  lessonId: string,
  by: Decider,
  decision: "accept" | "reject",
  reason: string,
  editedBody?: string,
): Promise<LessonView> {
  const lesson = getLesson(db, lessonId);
  if (lesson === null) throw new MemoryError("not_found", "no such lesson");
  const reviewerId = reviewerOf(db, lesson, by);
  const why = redact(reason).slice(0, MAX_REASON);
  if (decision === "reject") {
    claim(db, lesson.id, "rejected", reviewerId, why, lesson.body);
  } else {
    const body = editedBody === undefined ? lesson.body : cleanBody(editedBody);
    // The status flips first so a second reviewer is turned away at once; it flips back when the
    // note cannot be written, so no lesson stays accepted without a note.
    claim(db, lesson.id, "accepted", reviewerId, why, body);
    try {
      const noteId = await writeNote(db, home, lesson, body);
      db.query("UPDATE lessons SET note_id = ? WHERE id = ?").run(noteId, lesson.id);
    } catch (e) {
      release(db, lesson.id, lesson.body);
      throw e;
    }
  }
  const out = getLesson(db, lesson.id) as LessonView;
  emitDecided(out);
  return out;
}
