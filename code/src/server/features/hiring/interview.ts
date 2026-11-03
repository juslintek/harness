import type { Database } from "bun:sqlite";
import { specialties, taskTypes } from "../../../shared/router";
import { getMember, getOrg } from "../orgs/api";
import { getProfile } from "../profiles/api";
import {
  type RunDeps,
  ShuttingDownError,
  scratchRepo,
  startRun,
  waitForRun,
} from "../runtimes/api";
import { candidateRunEnded } from "./flow";
import type { HiringDeps } from "./hire";
import { getCandidate, getHire } from "./repo";

export interface InterviewEnv {
  runDeps: RunDeps;
  home: string;
}

const CARD_FIELDS = [
  "The card is an object with exactly these fields:",
  "- summary: string, at most 280 characters",
  `- specialties: up to 4 of ${specialties.join(", ")}`,
  "- strengths: up to 8 strings of at most 80 characters",
  "- limits: 1 to 8 strings of at most 80 characters, what you are bad at",
  `- preferredTaskTypes: 1 to 4 of ${taskTypes.join(", ")}`,
].join("\n");

function promptOf(db: Database, candidateId: string, questionIds: string[]): string | null {
  const cand = getCandidate(db, candidateId);
  const hire = cand ? getHire(db, cand.requestId) : null;
  const profile = cand ? getProfile(db, cand.profileId) : null;
  if (!hire || !profile) return null;
  const org = getOrg(db, hire.orgId)?.name ?? hire.orgId;
  const questions = hire.questions
    .filter((q) => questionIds.includes(q.id))
    .map((q) => `- ${q.id}: ${q.body}`);
  // A follow-up round comes after the card exists, so only the first round asks for it.
  const card =
    profile.card === null
      ? ", then submit your card with `profile_card_submit` (schema below)"
      : "";
  return [
    profile.persona,
    `You are interviewing for ${hire.spec.title} at ${org}. Answer each question with \`interview_answer\` (≤ 120 words each)${card}, then stop.`,
    `Questions (pass the id as \`question\`):\n${questions.join("\n")}`,
    ...(profile.card === null ? [CARD_FIELDS] : []),
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

// The run ends the interview whatever happened in it: no run, a crashed run and a clean one all
// report back, and the flow decides from the answers on file whether the candidate failed.
export async function runInterview(
  db: Database,
  env: InterviewEnv,
  deps: HiringDeps,
  candidateId: string,
  questionIds: string[],
): Promise<void> {
  let ok = false;
  try {
    const cand = getCandidate(db, candidateId);
    const profile = cand ? getProfile(db, cand.profileId) : null;
    const hire = cand ? getHire(db, cand.requestId) : null;
    const prompt = promptOf(db, candidateId, questionIds);
    if (!profile || !hire || prompt === null) throw new Error("candidate is gone");
    if (deps.budgetPaused(hire.requestedBy)) return candidateRunEnded(db, deps, candidateId, false);
    const runId = await startRun(db, env.runDeps, {
      agentId: profile.runtime,
      ...(profile.model ? { model: profile.model } : {}),
      repo: scratchRepo(env.home, hire.orgId),
      prompt,
      candidate: {
        candidateId,
        orgId: hire.orgId,
        chargedTo: getMember(db, hire.requestedBy)?.id ?? null,
      },
    });
    ok = (await waitForRun(runId)).state === "completed";
  } catch (err) {
    // The db may be closing: leave the candidate as it is rather than writing to it.
    if (err instanceof ShuttingDownError) return;
    console.error("interview run failed", candidateId, err);
  }
  candidateRunEnded(db, deps, candidateId, ok);
}
