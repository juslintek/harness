// The MCP tools the harness registers for agents. The guard allows a call only when its full
// name is one of these, and the mcp slice types its tool names with this list, so the two
// cannot drift apart.
export const HARNESS_TOOL_NAMES = [
  "chat_channels",
  "chat_read",
  "chat_post",
  "chat_dm",
  "board_list",
  "task_get",
  "task_create",
  "task_update",
  "task_checkout",
  "task_release",
  "task_move",
  "task_comment",
  "task_depend",
  "approvals_list",
  "approvals_decide",
] as const;

export type HarnessToolName = (typeof HARNESS_TOOL_NAMES)[number];
