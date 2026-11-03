import type { Database } from "bun:sqlite";
import { gitEnv } from "../../git-env";
import { getTask } from "../board/api";
import { listRunEvents } from "../logs/api";
import type { RunRow } from "../runtimes/api";

const MAX_CHARS = 4000;
const COMMAND_LINES = 20;
const COMMAND_CHARS = 200;

const GIT_TIMEOUT_MS = 10_000;

// Runs on the failover path inside the server, so a stuck git must not block it: the call is async
// and killed after the timeout, and whatever goes wrong only drops that section of the summary.
async function git(worktree: string, args: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "-C", worktree, ...args], {
      env: gitEnv(),
      stdout: "pipe",
      stderr: "ignore",
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out.trim() : "";
  } catch {
    return "";
  }
}

function section(title: string, body: string): string[] {
  return body === "" ? [] : [`${title}:`, body];
}

// The next engine gets this instead of the dead run's context, so it stays short and factual.
export async function handoffSummary(db: Database, run: RunRow): Promise<string> {
  const task = run.taskId ? getTask(db, run.taskId) : null;
  const commands = listRunEvents(db, run.id)
    .flatMap((e) => (e.command === null ? [] : [e.command.slice(0, COMMAND_CHARS)]))
    .slice(-COMMAND_LINES);
  const stopped =
    `Previous attempt on ${run.agentId}/${run.model ?? "default"} stopped: ${run.state} ${run.reason ?? ""}`.trim();
  const [status, diff] = run.worktree
    ? await Promise.all([
        git(run.worktree, ["status", "--short"]),
        git(run.worktree, ["diff", "--stat", "HEAD"]),
      ])
    : ["", ""];
  const lines = [
    ...(task ? [`Task #${task.number} ${task.title} (${task.status})`] : []),
    stopped,
    ...section("Last commands", commands.join("\n")),
    ...section("git status --short", status),
    ...section("git diff --stat HEAD", diff),
    "Continue from this state in the same worktree; do not redo finished steps.",
  ];
  const text = lines.join("\n");
  if (text.length <= MAX_CHARS) return text;
  // The closing instruction matters most, so the middle is what gets cut.
  const tail = lines[lines.length - 1] as string;
  return `${text.slice(0, MAX_CHARS - tail.length - 5)}\n...\n${tail}`;
}
