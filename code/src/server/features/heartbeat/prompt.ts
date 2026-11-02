import type { Database } from "bun:sqlite";
import { getTask } from "../board/api";
import { getChannel } from "../chat/api";
import { getOrg, listPositions, type MemberRow } from "../orgs/api";
import type { WakeRow } from "./repo";

const INSTRUCTION =
  "Use the harness MCP tools (`task_get`, `board_list`, `chat_read`, `chat_post`, `task_move`, `task_comment`...) to do the work and report back in the channel or task. Do not stop without updating the task status.";

function excerptOf(detail: unknown): string {
  const text = (detail as { excerpt?: unknown } | null)?.excerpt;
  return typeof text === "string" ? text : "";
}

function taskLabel(db: Database, taskId: string | null): string {
  const task = taskId === null ? null : getTask(db, taskId);
  return task ? `task #${task.number} "${task.title}" (${task.status})` : "a task";
}

function channelLabel(db: Database, channelId: string | null): string {
  const channel = channelId === null ? null : getChannel(db, channelId);
  return channel ? `#${channel.name}` : "a channel";
}

function describe(db: Database, wake: WakeRow): string {
  const text = excerptOf(wake.detail);
  switch (wake.reason) {
    case "assignment":
      return `${taskLabel(db, wake.taskId)} was assigned to you.`;
    case "comment":
      return `New comment on ${taskLabel(db, wake.taskId)}: ${text}`;
    case "mention":
      return `You were mentioned in ${channelLabel(db, wake.channelId)}: ${text}`;
    case "laya_mention":
      return `A message in ${channelLabel(db, wake.channelId)} matches your specialty: ${text}`;
    case "schedule":
      return "Your scheduled heartbeat: look at the board for work that is yours.";
    case "run_now":
      return "A person asked you to run now.";
  }
}

export function buildPrompt(db: Database, member: MemberRow, wakes: WakeRow[]): string {
  const org = getOrg(db, member.orgId);
  const titles = listPositions(db, member.orgId)
    .filter((p) => p.memberId === member.id)
    .map((p) => p.title);
  const who = `You are @${member.handle} in the org ${org?.name ?? member.orgId}${
    titles.length > 0 ? `, holding the position ${titles.join(", ")}` : ""
  }.`;
  const why = wakes.map((w) => `- ${describe(db, w)}`).join("\n");
  return `${who}\n\nYou were woken because:\n${why}\n\n${INSTRUCTION}`;
}
