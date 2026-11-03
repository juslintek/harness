import { z } from "zod";
import type { HireView } from "../../../shared/hiring";
import { specialties, taskTypes } from "../../../shared/router";
import { profileViewSchema } from "../orgs/profile-schema";

const candidateSchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "interviewing", "answered", "failed", "hired", "rejected"]),
  systemScore: z.number().nullable(),
  total: z.number().nullable(),
  profile: profileViewSchema,
  answers: z.array(
    z.object({
      questionId: z.string(),
      body: z.string(),
      runId: z.string().nullable(),
      createdAt: z.number(),
    }),
  ),
  scorecards: z.array(
    z.object({
      scorerId: z.string(),
      fit: z.number(),
      depth: z.number(),
      honesty: z.number(),
      notes: z.string(),
      createdAt: z.number(),
    }),
  ),
});

export const hireViewSchema: z.ZodType<HireView> = z.object({
  id: z.string(),
  orgId: z.string(),
  teamId: z.string(),
  requestedBy: z.string(),
  spec: z.object({
    title: z.string(),
    specialty: z.enum(specialties),
    summary: z.string(),
    mustHave: z.array(z.string()),
    taskTypes: z.array(z.enum(taskTypes)),
  }),
  status: z.enum([
    "interviewing",
    "followups",
    "answering",
    "scoring",
    "deciding",
    "hired",
    "rejected",
    "cancelled",
  ]),
  phaseStartedAt: z.number(),
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
  hiredMemberId: z.string().nullable(),
  onboarding: z.string().nullable(),
  createdAt: z.number(),
  candidates: z.array(candidateSchema),
  questions: z.array(
    z.object({
      id: z.string(),
      candidateId: z.string().nullable(),
      askedBy: z.string().nullable(),
      kind: z.enum(["base", "followup"]),
      body: z.string(),
      createdAt: z.number(),
    }),
  ),
  reviewers: z.array(z.object({ memberId: z.string(), asked: z.boolean() })),
});

export const hireListSchema: z.ZodType<HireView[]> = z.array(hireViewSchema);
