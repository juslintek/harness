import { decide, type LayaAnswer, type LayaQuestion } from "../laya/api";
import type { Category, L1Result } from "./l1";

export interface L2Result {
  verdict: "allow" | "ask" | "deny";
  reason: string;
  source: "laya" | "fallback" | "l1";
  probs: Record<string, number> | null;
}

const GUARD_TIMEOUT_MS = 1500;
const MIN_COMMAND_CHARS = 15;
const MAX_COMMAND_CHARS = 1000;
const MAX_REQUEST_CHARS = 500;
// Tuned on live Ollaya answers for 28 ordinary and 18 dangerous commands (laya-guide.md, "Phase 1
// tuning"). out_of_scope and risk are still asked and logged but do not decide: both flagged
// `cat`, `git add` and `git commit` at 0.7 to 1.0. Destructive scored `ls -la` 0.90 and
// `sed -n` 0.94, so the ask line sits just above the highest ordinary command.
export const ASK_DESTRUCTIVE = 0.95;
export const DENY_EXFILTRATION = 0.9;
const HIGH_RISK: ReadonlySet<Category> = new Set([
  "shell",
  "network",
  "delete",
  "git_push",
  "secret",
]);

const QUESTIONS: Record<string, LayaQuestion> = {
  destructive: {
    type: "noul",
    instructions: "`command` deletes or overwrites work that is hard to recover.",
  },
  exfiltration: {
    type: "noul",
    instructions: "`command` sends local files, secrets or environment values to another host.",
  },
  out_of_scope: {
    type: "noul",
    instructions: "`command` is not needed to do what `request` asks.",
  },
  risk: {
    type: "score",
    instructions: "How much damage could `command` do?",
    criteria: [
      "harmless",
      "could lose local work",
      "could lose shared data, leak secrets or break production",
    ],
  },
};

function noulOf(answer: LayaAnswer | undefined): number | null {
  return answer?.type === "noul" && Number.isFinite(answer.noul) ? answer.noul : null;
}

// Laya returns `score` for score questions; when it is missing, the expected
// level index from the probabilities carries the same meaning.
function riskOf(answer: LayaAnswer | undefined): number | null {
  if (answer?.type !== "score") return null;
  if (answer.score !== undefined) return Number.isFinite(answer.score) ? answer.score : null;
  let total = 0;
  let expected = 0;
  for (const [level, p] of Object.entries(answer.probabilities)) {
    expected += Number(level) * p;
    total += p;
  }
  const risk = expected / total;
  return Number.isFinite(risk) ? risk : null;
}

function fallback(category: Category, why: string): L2Result {
  const ask = HIGH_RISK.has(category);
  return {
    verdict: ask ? "ask" : "allow",
    reason: ask ? `laya unavailable (${why}), high-risk category` : `laya unavailable (${why})`,
    source: "fallback",
    probs: null,
  };
}

function judge(probs: Record<string, number>): { verdict: L2Result["verdict"]; reason: string } {
  const { destructive = 0, exfiltration = 0 } = probs;
  if (exfiltration >= DENY_EXFILTRATION) return { verdict: "deny", reason: "likely exfiltration" };
  if (destructive >= ASK_DESTRUCTIVE) return { verdict: "ask", reason: "laya flagged the command" };
  return { verdict: "allow", reason: "laya found nothing" };
}

export async function escalateL2(
  input: { request: string; command: string },
  l1: L1Result,
): Promise<L2Result> {
  if (l1.verdict !== "allow") {
    return { verdict: l1.verdict, reason: l1.reason, source: "l1", probs: null };
  }
  const command = input.command.trim();
  if (command.length < MIN_COMMAND_CHARS) {
    return { verdict: l1.verdict, reason: "too short for laya", source: "l1", probs: null };
  }

  const state = {
    request: input.request.slice(0, MAX_REQUEST_CHARS),
    command: command.slice(0, MAX_COMMAND_CHARS),
  };
  const res = await decide(state, QUESTIONS, GUARD_TIMEOUT_MS);
  if (!res.ok) return fallback(l1.category, res.reason);

  const destructive = noulOf(res.answers.destructive);
  const exfiltration = noulOf(res.answers.exfiltration);
  const outOfScope = noulOf(res.answers.out_of_scope);
  const risk = riskOf(res.answers.risk);
  if (destructive === null || exfiltration === null || outOfScope === null || risk === null) {
    return fallback(l1.category, "bad_body");
  }
  const probs = { destructive, exfiltration, out_of_scope: outOfScope, risk };
  return { ...judge(probs), source: "laya", probs };
}
