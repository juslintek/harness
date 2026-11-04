import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { decideLesson, MemoryError, proposeLessons } from "../memory/api";
import { getMember, roleAtLeast } from "../orgs/api";
import { defineTool, fail, type ToolCtx, type ToolEnv } from "./tools-kit";

// The member row is read on every call and must still belong to the token's org, so a removed or
// moved member loses the tool at once. Both tools write (a proposal row, an accepted note), so a
// viewer-role member is refused like it is for the memory tool.
function mustBeMember(ctx: ToolCtx): void {
  const member = getMember(ctx.db, ctx.memberId);
  if (member?.orgId !== ctx.orgId) fail("token does not match the member");
  if (!roleAtLeast(member.role, "member")) fail("you are not allowed to do that here");
}

async function readable<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof MemoryError) return fail(e.message);
    throw e;
  }
}

export function registerLessonTools(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    {
      name: "lesson_propose",
      scope: "memory",
      description:
        "After a task you did is done: propose 1 to 3 short, self-contained lessons a teammate will need in a later task. A reviewer accepts or rejects them. Never include secrets.",
      shape: { taskId: z.string(), lessons: z.array(z.string()).min(1).max(3) },
    },
    async (ctx, a) => {
      mustBeMember(ctx);
      const made = await readable(() =>
        proposeLessons(
          ctx.db,
          { memberId: ctx.memberId, runId: ctx.runId, taskId: a.taskId },
          a.lessons,
        ),
      );
      return `proposed ${made.length} lesson(s): ${made.map((l) => l.id).join(", ")}`;
    },
  );
  defineTool(
    server,
    env,
    {
      name: "lesson_review",
      scope: "memory",
      description:
        "Accept or reject a proposed lesson of a teammate, with a short reason. You may pass `body` to tighten the wording when accepting.",
      shape: {
        lessonId: z.string(),
        decision: z.enum(["accept", "reject"]),
        reason: z.string().max(500),
        body: z.string().optional(),
      },
    },
    async (ctx, a) => {
      mustBeMember(ctx);
      const by = { memberId: ctx.memberId, userId: null };
      const out = await readable(() =>
        decideLesson(ctx.db, ctx.harnessHome, a.lessonId, by, a.decision, a.reason, a.body),
      );
      return `${out.status} lesson ${out.id}`;
    },
  );
}
