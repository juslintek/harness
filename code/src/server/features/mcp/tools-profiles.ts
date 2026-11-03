import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCandidate, recordCardAnswer } from "../hiring/api";
import { findMemberByHandle, getMember } from "../orgs/api";
import { ensureProfile, profileOfMember, submitCard } from "../profiles/api";
import { defineCandidateTool, defineTool, fail, type ToolEnv } from "./tools-kit";

const cardShape = { card: z.record(z.string(), z.unknown()) };
const CARD_DESCRIPTION =
  "Submit your self-description card; invalid fields come back as text so you can retry";

function submit(db: ToolEnv["db"], profileId: string, card: unknown): string {
  const result = submitCard(db, profileId, card);
  return result.ok ? "ok" : fail(`invalid card: ${result.issues.join("; ")}`);
}

function registerGet(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    {
      name: "profile_get",
      scope: "profile",
      description: "Your own profile, or a teammate's by handle: card, runtime, model and skills",
      shape: { handle: z.string().optional() },
    },
    (ctx, a) => {
      const target = a.handle
        ? findMemberByHandle(ctx.db, ctx.orgId, a.handle.replace(/^@/, ""))
        : getMember(ctx.db, ctx.memberId);
      if (target?.kind !== "agent") return fail("no agent with that handle");
      // Reading a teammate must not create their profile row.
      const profile =
        target.id === ctx.memberId
          ? ensureProfile(ctx.db, target.id)
          : profileOfMember(ctx.db, target.id);
      if (!profile) return fail("no profile");
      const { runtime, model, skills, card } = profile;
      return { handle: target.handle, runtime, model, skills, card };
    },
  );
}

function registerCandidateSubmit(server: McpServer, env: ToolEnv): void {
  defineCandidateTool(
    server,
    env,
    { name: "profile_card_submit", description: CARD_DESCRIPTION, shape: cardShape },
    (ctx, a) => {
      const cand = getCandidate(ctx.db, ctx.candidateId);
      const open = cand && !["failed", "hired", "rejected"].includes(cand.status);
      if (!open) return fail("interview is closed");
      const out = submit(ctx.db, cand.profileId, a.card);
      recordCardAnswer(ctx.db, cand.id, ctx.runId);
      return out;
    },
  );
}

function registerMemberSubmit(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    {
      name: "profile_card_submit",
      scope: "profile",
      description: CARD_DESCRIPTION,
      shape: cardShape,
    },
    (ctx, a) => submit(ctx.db, ensureProfile(ctx.db, ctx.memberId).id, a.card),
  );
}

export function registerProfilesTools(server: McpServer, env: ToolEnv): void {
  registerGet(server, env);
  // One tool name serves both callers, so the token decides which profile it writes.
  if (env.identity.candidateId !== null) registerCandidateSubmit(server, env);
  else registerMemberSubmit(server, env);
}
