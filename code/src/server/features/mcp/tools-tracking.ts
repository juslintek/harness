import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, type MemberCtx, type ToolEnv } from "./tools-kit";
import { task } from "./tools-refs";

// task_create's own number is the creator's plan, so it is stored as a planner estimate as well.
export function recordPlannerEstimate(
  env: ToolEnv,
  ctx: MemberCtx,
  taskId: string,
  minutes: number | undefined,
): void {
  if (minutes === undefined) return;
  env.tracking.addEstimate(ctx.db, {
    taskId,
    kind: "planner",
    minutes,
    source: "agent",
    byMember: ctx.memberId,
  });
}

export function registerTrackingTools(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    {
      name: "task_estimate",
      scope: "board",
      description:
        "Record your estimate in minutes for a task: a planner estimate sizes the work, a reviewer estimate corrects it",
      shape: {
        task: z.union([z.number().int(), z.string()]),
        minutes: z.number().int().positive(),
        kind: z.enum(["planner", "reviewer"]),
        rationale: z.string().max(500).default(""),
      },
    },
    (ctx, a) => {
      env.tracking.addEstimate(ctx.db, {
        taskId: task(ctx, a.task, true).id,
        kind: a.kind,
        minutes: a.minutes,
        source: "agent",
        byMember: ctx.memberId,
        rationale: a.rationale,
      });
      return "ok";
    },
  );
}
