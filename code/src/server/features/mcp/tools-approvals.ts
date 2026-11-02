import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { approvalView, decidableApprovals, managerDecide } from "../guard/api";
import { defineTool, fail, type ToolEnv } from "./tools-kit";

export function registerApprovalTools(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    {
      name: "approvals_list",
      scope: "approvals_decide",
      description: "Pending approvals of your reports that you may decide",
      shape: {},
    },
    (ctx) =>
      decidableApprovals(ctx.db, ctx.memberId, ctx.harnessHome).map((row) => {
        const v = approvalView(row);
        return {
          id: v.id,
          runId: v.runId,
          command: v.command,
          reason: v.reason,
          expiresAt: v.expiresAt,
        };
      }),
  );
  defineTool(
    server,
    env,
    {
      name: "approvals_decide",
      scope: "approvals_decide",
      description: "Approve or deny a pending approval of one of your reports",
      shape: {
        id: z.string(),
        decision: z.enum(["approve", "deny"]),
        reason: z.string().min(1).max(500),
      },
    },
    (ctx, a) => {
      const r = managerDecide(ctx.db, {
        approvalId: a.id,
        managerMemberId: ctx.memberId,
        harnessHome: ctx.harnessHome,
        decision: a.decision,
        reason: a.reason,
      });
      return r.ok ? "ok" : fail(r.reason);
    },
  );
}
