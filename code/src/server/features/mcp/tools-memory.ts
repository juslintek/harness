import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { classifyNote } from "../laya/api";
import { agentViewer, projectSlugs, runProject, type WriteCtx } from "../memory/api";
import { defineTool, fail, type ToolCtx, type ToolEnv } from "./tools-kit";
import { type Op, runCommand } from "./tools-memory-ops";

const memoryShape = {
  action: z.enum([
    "view",
    "create",
    "str_replace",
    "insert",
    "delete",
    "rename",
    "search",
    "backlinks",
  ]),
  path: z.string().optional(),
  view_range: z.array(z.number().int()).length(2).optional(),
  file_text: z.string().optional(),
  old_str: z.string().optional(),
  new_str: z.string().optional(),
  insert_line: z.number().int().min(0).optional(),
  insert_text: z.string().optional(),
  old_path: z.string().optional(),
  new_path: z.string().optional(),
  query: z.string().optional(),
  scope: z.enum(["global", "org", "project", "agent"]).optional(),
  type: z.enum(["lesson", "fact", "decision", "howto", "reference"]).optional(),
  tag: z.string().optional(),
};

// Org, project reach and handle come from the member row on every call, never from the token or an
// earlier call, so an access change takes effect on the very next command.
function opFor(ctx: ToolCtx): Op {
  let viewer: ReturnType<typeof agentViewer>;
  try {
    viewer = agentViewer(ctx.db, ctx.memberId);
  } catch {
    return fail("this token's member no longer exists");
  }
  if (viewer.orgId !== ctx.orgId) return fail("token does not match the member's org");
  const write: WriteCtx = { viewer, runId: ctx.runId, classify: classifyNote };
  return {
    db: ctx.db,
    home: ctx.harnessHome,
    viewer,
    runId: ctx.runId,
    slugs: projectSlugs(ctx.db, viewer.orgId),
    write,
    projectId: runProject(ctx.db, ctx.runId),
  };
}

export function registerMemoryTools(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    {
      name: "memory",
      scope: "memory",
      description:
        "Shared notes under /memories: agent/ (yours), project/<key>/, org/ and global/ (read only). " +
        "Commands: view a folder or a file, create, str_replace, insert, delete, rename, " +
        "search (text query, optional scope, type, tag) and backlinks. Search before you start work, " +
        "and save what a teammate would need. Never store secrets.",
      shape: memoryShape,
    },
    (ctx, a) => runCommand(opFor(ctx), a),
  );
}
