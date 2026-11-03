import { z } from "zod";
import type { ProfileView } from "./profiles";
import { type Specialty, specialties, type TaskType, taskTypes } from "./router";

export type HireStatus =
  | "interviewing"
  | "followups"
  | "answering"
  | "scoring"
  | "deciding"
  | "hired"
  | "rejected"
  | "cancelled";

export interface RoleSpec {
  title: string;
  specialty: Specialty;
  summary: string;
  mustHave: string[];
  taskTypes: TaskType[];
}
const roleSpecSchema: z.ZodType<RoleSpec> = z
  .object({
    title: z.string().min(1).max(60),
    specialty: z.enum(specialties),
    summary: z.string().min(1).max(500),
    mustHave: z.array(z.string().min(1).max(80)).max(6),
    taskTypes: z.array(z.enum(taskTypes)).min(1).max(4),
  })
  .strict();

export interface CreateHireBody {
  teamId: string;
  spec: RoleSpec;
  maxCandidates: number;
}
export const createHireBody: z.ZodType<CreateHireBody> = z
  .object({
    teamId: z.string().min(1),
    spec: roleSpecSchema,
    maxCandidates: z.number().int().min(1).max(3).default(2),
  })
  .strict();

export interface ScoreBody {
  fit: number;
  depth: number;
  honesty: number;
  notes: string;
}
const criterion = z.number().int().min(1).max(5);
export const scoreBody: z.ZodType<ScoreBody> = z
  .object({
    fit: criterion,
    depth: criterion,
    honesty: criterion,
    notes: z.string().max(1000).default(""),
  })
  .strict();

export interface DecideBody {
  candidateId: string | null;
  reason: string;
}
export const decideBody: z.ZodType<DecideBody> = z
  .object({ candidateId: z.string().min(1).nullable(), reason: z.string().max(500).default("") })
  .strict();

export interface Scorecard {
  scorerId: string;
  fit: number;
  depth: number;
  honesty: number;
  notes: string;
  createdAt: number;
}
export interface InterviewQuestion {
  id: string;
  candidateId: string | null;
  askedBy: string | null;
  kind: "base" | "followup";
  body: string;
  createdAt: number;
}
export interface InterviewAnswer {
  questionId: string;
  body: string;
  runId: string | null;
  createdAt: number;
}
export type CandidateStatus =
  | "pending"
  | "interviewing"
  | "answered"
  | "failed"
  | "hired"
  | "rejected";
interface CandidateView {
  id: string;
  status: CandidateStatus;
  systemScore: number | null;
  total: number | null;
  profile: ProfileView;
  answers: InterviewAnswer[];
  scorecards: Scorecard[];
}
export interface HireView {
  id: string;
  orgId: string;
  teamId: string;
  requestedBy: string;
  spec: RoleSpec;
  status: HireStatus;
  phaseStartedAt: number;
  decidedBy: string | null;
  decisionReason: string | null;
  hiredMemberId: string | null;
  onboarding: string | null;
  createdAt: number;
  candidates: CandidateView[];
  questions: InterviewQuestion[];
  reviewers: { memberId: string; asked: boolean }[];
}
