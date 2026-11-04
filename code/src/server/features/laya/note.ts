import type { NoteScope, NoteType } from "../../../shared/memory";
import { decide, type LayaQuestion } from "./client";
import { confident } from "./task";

export interface NoteClass {
  type: NoteType;
  scope: NoteScope;
  confidence: number;
  source: "laya" | "fallback";
}

const MAX_TEXT_CHARS = 1500;
const TIMEOUT_MS = 1500;
const MIN_P = 0.5;
const SCOPE_ORDER: NoteScope[] = ["project", "agent", "org"];
const TYPES: readonly NoteType[] = ["lesson", "fact", "decision", "howto", "reference"];

const QUESTIONS: Record<string, LayaQuestion> = {
  type: {
    type: "choice",
    instructions: "What kind of note is `text`?",
    criteria: {
      lesson: "something learned from a mistake or a finished piece of work",
      fact: "a statement about how things are",
      decision: "a choice that was made and why",
      howto: "steps or a rule for doing something",
      reference: "a pointer to docs, a link or where something lives",
    },
  },
  scope: {
    type: "choice",
    instructions: "Who should see the note `text`?",
    criteria: {
      project: "only useful for one project",
      agent: "personal to the agent that wrote it",
      org: "useful across the whole organization",
    },
  },
};

const TYPE_RULES: [RegExp, NoteType][] = [
  [/\b(decided|chose)\b/, "decision"],
  [/\b(always|never|run|use|how to|steps)\b/, "howto"],
  [/\b(see|link|docs|url)\b/, "reference"],
];

function fallbackType(text: string, hint?: NoteType): NoteType {
  const lower = text.toLowerCase();
  return TYPE_RULES.find(([re]) => re.test(lower))?.[1] ?? hint ?? "fact";
}

function fallbackScope(allowed: NoteScope[]): NoteScope {
  return SCOPE_ORDER.find((s) => allowed.includes(s)) ?? allowed[0] ?? "project";
}

export async function classifyNote(
  text: string,
  allowed: NoteScope[],
  hint?: NoteType,
): Promise<NoteClass> {
  const trimmed = text.trim().slice(0, MAX_TEXT_CHARS);
  const base = { type: fallbackType(trimmed, hint), scope: fallbackScope(allowed) };
  const res = await decide({ text: trimmed }, QUESTIONS, TIMEOUT_MS);
  if (!res.ok) return { ...base, confidence: MIN_P, source: "fallback" };
  const type = confident(res.answers.type, TYPES);
  const scope = confident(res.answers.scope, allowed);
  return {
    type: type?.value ?? base.type,
    scope: scope?.value ?? base.scope,
    confidence: type?.p ?? MIN_P,
    source: "laya",
  };
}
