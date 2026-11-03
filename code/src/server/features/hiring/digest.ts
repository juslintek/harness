import type { Database } from "bun:sqlite";
import type { HireView } from "../../../shared/hiring";
import type { SelfCard } from "../../../shared/profiles";
import { getMember } from "../orgs/api";

export interface HireDigest {
  hire: string;
  team: string;
  title: string;
  specialty: string;
  summary: string;
  status: string;
  candidates: {
    candidate: string;
    runtime: string;
    model: string | null;
    status: string;
    total: number | null;
    card: SelfCard | null;
    answers: { question: string; answer: string }[];
    scorecards: { by: string; fit: number; depth: number; honesty: number; notes: string }[];
  }[];
}

// What a reviewer needs to judge a request, shared by the hire_list tool and the wake prompts.
export function hireDigest(db: Database, h: HireView): HireDigest {
  const questions = new Map(h.questions.map((q) => [q.id, q.body]));
  return {
    hire: h.id,
    team: h.teamId,
    title: h.spec.title,
    specialty: h.spec.specialty,
    summary: h.spec.summary,
    status: h.status,
    candidates: h.candidates.map((c) => ({
      candidate: c.id,
      runtime: c.profile.runtime,
      model: c.profile.model,
      status: c.status,
      total: c.total,
      card: c.profile.card,
      answers: c.answers.map((a) => ({
        question: questions.get(a.questionId) ?? "",
        answer: a.body,
      })),
      scorecards: c.scorecards.map((s) => ({
        by: getMember(db, s.scorerId)?.handle ?? s.scorerId,
        fit: s.fit,
        depth: s.depth,
        honesty: s.honesty,
        notes: s.notes,
      })),
    })),
  };
}
