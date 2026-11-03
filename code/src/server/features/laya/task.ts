import {
  type Difficulty,
  difficulties,
  type SizeBucket,
  type Specialty,
  sizeBuckets,
  specialties,
  type TaskType,
  taskTypes,
} from "../../../shared/router";
import { decide, type LayaAnswer, type LayaQuestion } from "./client";

export interface TaskTriage {
  source: "laya" | "fallback";
  difficulty: Difficulty;
  taskType: TaskType;
  specialty: Specialty | null;
  size: SizeBucket;
  p: Record<string, number>;
}

const MAX_TEXT_CHARS = 1500;
const TIMEOUT_MS = 2000;
const MIN_P = 0.5;

const QUESTIONS: Record<string, LayaQuestion> = {
  difficulty: {
    type: "choice",
    instructions: "How hard is the work described in `text`?",
    criteria: {
      easy: "a small, well understood change",
      medium: "needs some design or reading of existing code",
      hard: "unclear, risky or touches many parts",
    },
  },
  taskType: {
    type: "choice",
    instructions: "What kind of work is `text`?",
    criteria: {
      feature: "new behaviour",
      bugfix: "something is broken",
      refactor: "restructure without changing behaviour",
      test: "write or fix tests",
      docs: "documentation",
      review: "review someone else's work",
      ops: "deploy, CI, infrastructure",
      research: "investigate and report",
    },
  },
  specialty: {
    type: "choice",
    instructions: "Which skill does `text` mainly need?",
    criteria: {
      frontend: "UI, CSS, browser code",
      backend: "server code, APIs, business logic",
      database: "schema, queries, migrations",
      devops: "CI, deploy, containers, servers",
      security: "auth, secrets, vulnerabilities",
      writing: "docs, copy, release notes",
      mobile: "iOS or Android apps",
      unknown: "unclear or mixed",
    },
  },
  size: {
    type: "choice",
    instructions: "How much work is `text` for one person?",
    criteria: {
      xs: "minutes, a one-line change",
      s: "about an hour",
      m: "about half a day",
      l: "a few days",
      xl: "a week or more",
    },
  },
};

const TYPE_RULES: [RegExp, TaskType][] = [
  [/\b(fix|bug|crash)/, "bugfix"],
  [/\btest/, "test"],
  [/\bdoc|readme/, "docs"],
  [/\b(refactor|rename|clean)/, "refactor"],
  [/\b(deploy|docker)|\bci\b/, "ops"],
];

const SPECIALTY_RULES: [RegExp, Specialty][] = [
  [/\b(sql|migration|query|schema|index)/, "database"],
  [/\b(css|page|component)|\bui\b/, "frontend"],
  [/\b(endpoint|server)|\bapi\b/, "backend"],
];

function firstMatch<T>(rules: [RegExp, T][], text: string): T | null {
  return rules.find(([re]) => re.test(text))?.[1] ?? null;
}

function fallbackSize(text: string): SizeBucket {
  if (text.length <= 120) return "s";
  return text.length <= 600 ? "m" : "l";
}

function triageFallback(text: string): TaskTriage {
  return {
    source: "fallback",
    difficulty: "medium",
    taskType: firstMatch(TYPE_RULES, text) ?? "feature",
    specialty: firstMatch(SPECIALTY_RULES, text),
    size: fallbackSize(text),
    p: {},
  };
}

// A label counts only when Laya is at least MIN_P sure of a label we know.
function confident<T extends string>(
  answer: LayaAnswer | undefined,
  allowed: readonly T[],
): { value: T; p: number } | null {
  if (answer?.type !== "choice") return null;
  const p = answer.probabilities[answer.choice] ?? 0;
  const known = (allowed as readonly string[]).includes(answer.choice);
  return known && p >= MIN_P ? { value: answer.choice as T, p } : null;
}

// "unknown" is a sure answer that no specialty fits, so it must not fall back to keywords.
function sureNone(answer: LayaAnswer | undefined): boolean {
  return (
    answer?.type === "choice" &&
    answer.choice === "unknown" &&
    (answer.probabilities.unknown ?? 0) >= MIN_P
  );
}

export async function triageTask(text: string): Promise<TaskTriage> {
  const trimmed = text.trim().slice(0, MAX_TEXT_CHARS);
  const base = triageFallback(trimmed.toLowerCase());
  const res = await decide({ text: trimmed }, QUESTIONS, TIMEOUT_MS);
  if (!res.ok) return base;
  const { answers } = res;
  const difficulty = confident(answers.difficulty, difficulties);
  const taskType = confident(answers.taskType, taskTypes);
  const size = confident(answers.size, sizeBuckets);
  const specialty = confident(answers.specialty, specialties);
  const p: Record<string, number> = {};
  for (const [field, hit] of Object.entries({ difficulty, taskType, specialty, size })) {
    if (hit) p[field] = hit.p;
  }
  return {
    source: "laya",
    difficulty: difficulty?.value ?? base.difficulty,
    taskType: taskType?.value ?? base.taskType,
    specialty: specialty?.value ?? (sureNone(answers.specialty) ? null : base.specialty),
    size: size?.value ?? base.size,
    p,
  };
}
