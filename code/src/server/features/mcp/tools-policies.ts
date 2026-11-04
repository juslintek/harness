import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type PolicyKey, policyKeyNames } from "../../../shared/policies";
import { findMemberByHandle } from "../orgs/api";
import {
  contextForMember,
  decideProposal,
  explain,
  getProposal,
  propose,
  review,
} from "../policies/api";
import { defineTool, fail, type ToolCtx, type ToolEnv } from "./tools-kit";

const key = z.string().refine((k): k is PolicyKey => policyKeyNames.includes(k as PolicyKey), {
  message: "unknown policy key",
});

// The policy core throws plain errors; the agent should read why, not get "internal error".
function refusal<T>(run: () => T): T {
  try {
    return run();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

// A proposal of another org looks the same as a missing one, so ids do not leak across orgs.
function ownProposal(ctx: ToolCtx, id: string): string {
  return getProposal(ctx.db, id)?.orgId === ctx.orgId ? id : fail("unknown proposal");
}

function reviewerIds(ctx: ToolCtx, handles: string[]): string[] {
  return handles.map((handle) => {
    const member = findMemberByHandle(ctx.db, ctx.orgId, handle.replace(/^@/, ""));
    return member?.id ?? fail(`no member @${handle.replace(/^@/, "")}`);
  });
}

function readTools(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    {
      name: "policy_get",
      scope: "policy",
      description:
        "The policies that apply to you now, each with the layer that decides it and the chain of layers above",
      shape: { key: key.optional() },
    },
    (ctx, a) =>
      explain(ctx.db, contextForMember(ctx.db, ctx.memberId))
        .filter((e) => a.key === undefined || e.key === a.key)
        .map(({ key: name, value, layer, chain }) => ({ key: name, value, layer, chain })),
  );
}

// A proposal always targets the member who files it, so an agent cannot propose for another
// member or a team; whoever decides it can only approve what the layers above allow.
function proposeTool(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    {
      name: "policy_propose",
      scope: "policy",
      description:
        "Propose a policy value for yourself; a manager of yours or a person decides it. Name reviewers by handle to have them comment first",
      shape: {
        key,
        value: z.unknown(),
        reason: z.string().min(1).max(500),
        reviewers: z.array(z.string()).max(5).optional(),
      },
    },
    (ctx, a) => {
      const reviewers = reviewerIds(ctx, a.reviewers ?? []);
      const proposal = refusal(() =>
        propose(ctx.db, {
          orgId: ctx.orgId,
          memberId: ctx.memberId,
          key: a.key,
          value: a.value,
          reason: a.reason,
          reviewers,
        }),
      );
      return { proposal: proposal.id, status: proposal.status };
    },
  );
}

function reviewTool(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    {
      name: "policy_review",
      scope: "policy",
      description: "Say whether a policy proposal you were asked about is sound",
      shape: {
        proposal: z.string(),
        verdict: z.enum(["approve", "reject"]),
        comment: z.string().max(1000).default(""),
      },
    },
    (ctx, a) => {
      const proposalId = ownProposal(ctx, a.proposal);
      refusal(() =>
        review(ctx.db, {
          proposalId,
          reviewerId: ctx.memberId,
          verdict: a.verdict,
          comment: a.comment,
        }),
      );
      return "ok";
    },
  );
}

function decideTool(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    {
      name: "policy_decide",
      scope: "policy",
      description:
        "Approve or reject a policy proposal of one of your reports; you can never approve a loosening of a tighten-only policy",
      shape: {
        proposal: z.string(),
        decision: z.enum(["approve", "reject"]),
        reason: z.string().max(500).default(""),
      },
    },
    (ctx, a) => {
      const result = decideProposal(ctx.db, {
        proposalId: ownProposal(ctx, a.proposal),
        decidedBy: { kind: "agent", memberId: ctx.memberId },
        decision: a.decision,
        reason: a.reason,
      });
      return result.ok ? "ok" : fail(result.reason);
    },
  );
}

export function registerPoliciesTools(server: McpServer, env: ToolEnv): void {
  readTools(server, env);
  proposeTool(server, env);
  reviewTool(server, env);
  decideTool(server, env);
}
