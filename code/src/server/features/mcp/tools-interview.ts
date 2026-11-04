import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ask,
  getHire,
  type HiringDeps,
  hiringDeps,
  pass,
  recordAnswer,
  score,
} from "../hiring/api";
import { defineCandidateTool, defineTool, fail, type ToolEnv } from "./tools-kit";

const MAX_ANSWER_CHARS = 2000;
const rating = z.number().int().min(1).max(5);

export function activeHiring(): HiringDeps {
  return hiringDeps() ?? fail("hiring is not running");
}

// A request of another org looks the same as a missing one, so ids do not leak across orgs.
export function ownHire(
  db: ToolEnv["db"],
  orgId: string,
  id: string,
): NonNullable<ReturnType<typeof getHire>> {
  const hire = getHire(db, id);
  return hire?.orgId === orgId ? hire : fail("unknown hire");
}

function answerTool(server: McpServer, env: ToolEnv): void {
  defineCandidateTool(
    server,
    env,
    {
      name: "interview_answer",
      description: "Answer one interview question by its id (at most 120 words)",
      shape: { question: z.string(), answer: z.string().min(1).max(MAX_ANSWER_CHARS) },
    },
    (ctx, a) => {
      recordAnswer(ctx.db, ctx.candidateId, a.question, a.answer, ctx.runId);
      return "ok";
    },
  );
}

function followupTools(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    {
      name: "interview_ask",
      scope: "hiring",
      description: "Ask one candidate a follow-up question while follow-ups are open",
      shape: { hire: z.string(), candidate: z.string(), question: z.string() },
    },
    (ctx, a) => {
      const hire = ownHire(ctx.db, ctx.orgId, a.hire);
      ask(ctx.db, activeHiring(), {
        requestId: hire.id,
        reviewerId: ctx.memberId,
        candidateId: a.candidate,
        body: a.question,
      });
      return "ok";
    },
  );
  defineTool(
    server,
    env,
    {
      name: "interview_pass",
      scope: "hiring",
      description: "Say you have no more follow-up questions for this hire request",
      shape: { hire: z.string() },
    },
    (ctx, a) => {
      pass(ctx.db, activeHiring(), ownHire(ctx.db, ctx.orgId, a.hire).id, ctx.memberId);
      return "ok";
    },
  );
}

function scoreTool(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    {
      name: "interview_score",
      scope: "hiring",
      description: "Score a candidate from 1 to 5 on fit, depth and honesty",
      shape: {
        hire: z.string(),
        candidate: z.string(),
        fit: rating,
        depth: rating,
        honesty: rating,
        notes: z.string().max(1000).default(""),
      },
    },
    (ctx, a) => {
      const hire = ownHire(ctx.db, ctx.orgId, a.hire);
      if (!hire.candidates.some((c) => c.id === a.candidate)) fail("unknown candidate");
      score(ctx.db, activeHiring(), {
        candidateId: a.candidate,
        scorerId: ctx.memberId,
        fit: a.fit,
        depth: a.depth,
        honesty: a.honesty,
        notes: a.notes,
      });
      return "ok";
    },
  );
}

export function registerInterviewTools(server: McpServer, env: ToolEnv): void {
  answerTool(server, env);
  followupTools(server, env);
  scoreTool(server, env);
}
