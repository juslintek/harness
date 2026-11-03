import type { Database } from "bun:sqlite";
import { gitEnv } from "../../git-env";
import { getTask } from "../board/api";
import { listRunEvents } from "../logs/api";
import type { RunRow } from "../runtimes/api";

const MAX_CHARS = 4000;
const COMMAND_LINES = 20;
const COMMAND_CHARS = 200;

function git(worktree: string, args: string[]): string {
  try {
    const res = Bun.spawnSync(["git", "-C", worktree, ...args], { env: gitEnv() });
    return res.exitCode === 0 ? res.stdout.toString().trim() : "";
  } catch {
    return "";
  }
}

function section(title: string, body: string): string[] {
  return body === "" ? [] : [`${title}:`, body];
}

// The next engine gets this instead of the dead run's context, so it stays short and factual.
export function handoffSummary(db: Database, run: RunRow): string {
  const task = run.taskId ? getTask(db, run.taskId) : null;
  const commands = listRunEvents(db, run.id)
    .flatMap((e) => (e.command === null ? [] : [e.command.slice(0, COMMAND_CHARS)]))
    .slice(-COMMAND_LINES);
  const stopped =
    `Previous attempt on ${run.agentId}/${run.model ?? "default"} stopped: ${run.state} ${run.reason ?? ""}`.trim();
  const lines = [
    ...(task ? [`Task #${task.number} ${task.title} (${task.status})`] : []),
    stopped,
    ...section("Last commands", commands.join("\n")),
    ...(run.worktree
      ? [
          ...section("git status --short", git(run.worktree, ["status", "--short"])),
          ...section("git diff --stat HEAD", git(run.worktree, ["diff", "--stat", "HEAD"])),
        ]
      : []),
    "Continue from this state in the same worktree; do not redo finished steps.",
  ];
  const text = lines.join("\n");
  if (text.length <= MAX_CHARS) return text;
  // The closing instruction matters most, so the middle is what gets cut.
  const tail = lines[lines.length - 1] as string;
  return `${text.slice(0, MAX_CHARS - tail.length - 5)}\n...\n${tail}`;
}
