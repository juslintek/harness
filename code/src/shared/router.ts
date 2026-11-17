import { z } from "zod";

export const specialties = [
  "frontend",
  "backend",
  "database",
  "devops",
  "security",
  "writing",
  "mobile",
] as const;
export type Specialty = (typeof specialties)[number];

export const taskTypes = [
  "feature",
  "bugfix",
  "refactor",
  "test",
  "docs",
  "review",
  "ops",
  "research",
] as const;
export type TaskType = (typeof taskTypes)[number];

export const difficulties = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof difficulties)[number];

export const sizeBuckets = ["xs", "s", "m", "l", "xl"] as const;
export type SizeBucket = (typeof sizeBuckets)[number];

// Human-minute prior per size bucket, used until a member has enough finished tasks of its own.
export const SIZE_PRIOR_MINUTES: Readonly<Record<SizeBucket, number>> = {
  xs: 15,
  s: 60,
  m: 240,
  l: 960,
  xl: 2880,
};

export interface Engine {
  runtime: string;
  model: string | null;
}

// Provider key in the models.dev registry per agent runtime; runtimes not listed have no prices.
export const REGISTRY_PROVIDER: Readonly<Record<string, string>> = {
  claude: "anthropic",
  codex: "openai",
  gemini: "google",
  agy: "google",
  copilot: "github-copilot",
};

// Quota provider per runtime, as written by the quota tailers; runtimes not listed have no known limits.
export const QUOTA_PROVIDER: Readonly<Record<string, string>> = {
  claude: "claude",
  codex: "codex",
  agy: "agy",
};

export interface QuotaBody {
  provider: string;
  accountId?: string | undefined;
  window: string;
  usedPercent: number;
  resetsAt?: number | undefined;
}

export const quotaBodySchema: z.ZodType<QuotaBody> = z
  .object({
    provider: z.string().min(1).max(40),
    accountId: z.string().min(1).max(100).optional(),
    window: z.string().min(1).max(40),
    usedPercent: z.number().min(0).max(100),
    resetsAt: z.number().int().positive().optional(),
  })
  .strict()
  // A default account id names its provider; any other id is opaque.
  .refine((b) => !b.accountId?.startsWith("default:") || b.accountId === `default:${b.provider}`, {
    message: "accountId belongs to another provider",
    path: ["accountId"],
  });
