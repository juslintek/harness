import { decide, type LayaQuestion } from "./client";

export type Specialty =
  | "frontend"
  | "backend"
  | "database"
  | "devops"
  | "security"
  | "writing"
  | "mobile";

export interface WakeTriage {
  source: "laya" | "fallback" | "skipped";
  chitchat: number | null;
  specialty: Specialty | null;
  p: number | null;
}

const MIN_TEXT_CHARS = 15;
const MAX_TEXT_CHARS = 1500;
const TIMEOUT_MS = 1500;
const SPECIALTY_MIN_P = 0.6;
const CHITCHAT_GATE = 0.8;
const SPECIALTIES: ReadonlySet<string> = new Set<Specialty>([
  "frontend",
  "backend",
  "database",
  "devops",
  "security",
  "writing",
  "mobile",
]);

const QUESTIONS: Record<string, LayaQuestion> = {
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
      unknown: "small talk, unclear or mixed",
    },
  },
  chitchat: {
    type: "noul",
    instructions: "`text` is thanks, a greeting or small talk that needs no action.",
  },
};

const FALLBACK: WakeTriage = { source: "fallback", chitchat: null, specialty: null, p: null };

// Laya only labels the message; matching the label to an agent's specialties is the caller's job
// because putting the agent profile in the state did not discriminate (laya-guide.md 6(b)).
export async function triageWake(text: string): Promise<WakeTriage> {
  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_CHARS) {
    return { source: "skipped", chitchat: null, specialty: null, p: null };
  }
  const res = await decide({ text: trimmed.slice(0, MAX_TEXT_CHARS) }, QUESTIONS, TIMEOUT_MS);
  if (!res.ok) return FALLBACK;
  const chat = res.answers.chitchat;
  const spec = res.answers.specialty;
  if (chat?.type !== "noul" || spec?.type !== "choice") return FALLBACK;
  const p = spec.probabilities[spec.choice] ?? null;
  const confident = SPECIALTIES.has(spec.choice) && p !== null && p >= SPECIALTY_MIN_P;
  const social = chat.noul >= CHITCHAT_GATE;
  return {
    source: "laya",
    chitchat: chat.noul,
    specialty: confident && !social ? (spec.choice as Specialty) : null,
    p,
  };
}
