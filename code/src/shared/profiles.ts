import { z } from "zod";
import { type Engine, type Specialty, specialties, type TaskType, taskTypes } from "./router";

export interface SelfCard {
  summary: string;
  specialties: Specialty[];
  strengths: string[];
  limits: string[];
  preferredTaskTypes: TaskType[];
}

export const selfCardSchema: z.ZodType<SelfCard> = z
  .object({
    summary: z.string().min(1).max(280),
    specialties: z.array(z.enum(specialties)).max(4),
    strengths: z.array(z.string().min(1).max(80)).max(8),
    limits: z.array(z.string().min(1).max(80)).min(1).max(8),
    preferredTaskTypes: z.array(z.enum(taskTypes)).min(1).max(4),
  })
  .strict();

const profileScopeSchema = z.object({ readOnly: z.boolean().default(false) }).strict();

const engineSchema: z.ZodType<Engine> = z
  .object({ runtime: z.string().min(1).max(40), model: z.string().min(1).nullable() })
  .strict();

export interface ProfileInput {
  runtime: string;
  model: string | null;
  persona: string;
  skills: string[];
  scope: { readOnly: boolean };
  fallbacks: Engine[];
}
export type ProfilePatch = Partial<ProfileInput>;

export const profileInputSchema: z.ZodType<ProfileInput> = z
  .object({
    runtime: z.string().min(1).max(40),
    model: z.string().min(1).nullable(),
    persona: z.string().max(2000),
    skills: z.array(z.string().min(1).max(60)).max(20),
    scope: profileScopeSchema,
    fallbacks: z.array(engineSchema).max(3),
  })
  .strict();

export interface ProfileView extends ProfileInput {
  id: string;
  orgId: string;
  card: SelfCard | null;
  cardAt: number | null;
}
