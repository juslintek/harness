import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { specialties, taskTypes } from "../../../shared/router";
import { approverOf, decide, fileRequest, hireDigest, listHires, teamIdsOf } from "../hiring/api";
import { listTeams } from "../orgs/api";
import { effective } from "../policies/api";
import { activeHiring, ownHire, registerInterviewTools } from "./tools-interview";
import { defineTool, fail, type ToolCtx, type ToolEnv } from "./tools-kit";

const CLOSED = new Set(["hired", "rejected", "cancelled"]);

function teamOf(ctx: ToolCtx, ref: string | undefined): string {
  const mine = teamIdsOf(ctx.db, ctx.memberId);
  if (ref === undefined) {
    const [only, ...more] = mine;
    if (only === undefined) return fail("you are in no team");
    return more.length === 0 ? only : fail("you are in several teams: pass team");
  }
  const team = listTeams(ctx.db, ctx.orgId).find((t) => t.id === ref || t.name === ref);
  return team && mine.includes(team.id) ? team.id : fail("unknown team, or you are not in it");
}

function requestTool(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    {
      name: "hire_request",
      scope: "hiring",
      description: "Ask for a new team member: interviews candidates on the available runtimes",
      shape: {
        team: z.string().optional(),
        title: z.string().min(1).max(60),
        specialty: z.enum(specialties),
        summary: z.string().min(1).max(500),
        mustHave: z.array(z.string().min(1).max(80)).max(6).optional(),
        taskTypes: z.array(z.enum(taskTypes)).min(1).max(4),
      },
    },
    async (ctx, a) => {
      const { team: _team, mustHave, ...rest } = a;
      const hire = await fileRequest(ctx.db, activeHiring(), {
        orgId: ctx.orgId,
        teamId: teamOf(ctx, a.team),
        requestedBy: ctx.memberId,
        spec: { ...rest, mustHave: mustHave ?? [] },
      });
      return { hire: hire.id, status: hire.status, candidates: hire.candidates.length };
    },
  );
}

function listTool(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    {
      name: "hire_list",
      scope: "hiring",
      description:
        "Open hire requests of your teams, with each candidate's answers, card and scores",
      shape: {},
    },
    (ctx) => {
      const teams = teamIdsOf(ctx.db, ctx.memberId);
      return listHires(ctx.db, ctx.orgId)
        .filter((h) => !CLOSED.has(h.status))
        .filter(
          (h) =>
            teams.includes(h.teamId) ||
            h.reviewers.some((r) => r.memberId === ctx.memberId) ||
            approverOf(ctx.db, h) === ctx.memberId,
        )
        .map((h) => hireDigest(ctx.db, h));
    },
  );
}

function decideTool(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    {
      name: "hire_decide",
      scope: "hiring",
      description:
        'Hire one candidate, or pass "none" to reject all; only the manager asked to decide',
      shape: { hire: z.string(), candidate: z.string(), reason: z.string().max(500).default("") },
    },
    (ctx, a) => {
      const hire = ownHire(ctx.db, ctx.orgId, a.hire);
      const mode = effective(ctx.db, { orgId: hire.orgId, teamId: hire.teamId }, "hiring.decision");
      if (mode.value === "human") fail("this org lets only a person decide hires");
      const result = decide(ctx.db, activeHiring(), {
        requestId: hire.id,
        candidateId: a.candidate === "none" ? null : a.candidate,
        decidedBy: ctx.memberId,
        reason: a.reason,
      });
      return result.ok ? { ok: true, member: result.memberId ?? null } : fail(result.reason);
    },
  );
}

export function registerHiringTools(server: McpServer, env: ToolEnv): void {
  registerInterviewTools(server, env);
  requestTool(server, env);
  listTool(server, env);
  decideTool(server, env);
}
