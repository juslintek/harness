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
