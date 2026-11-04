import type { Database } from "bun:sqlite";
import type { NoteSummary } from "../../../shared/memory";
import { getSpec } from "../agents/api";
import { getTask } from "../board/api";
import {
  agentViewer,
  buildMemoryIndex,
  projectSlugs,
  searchNotes,
  virtualPathOf,
} from "../memory/api";
import { getProject, type MemberRow } from "../orgs/api";
import type { WakeRow } from "./repo";
import type { ExecDeps } from "./run-input";

const HITS = 5;
const WITH_TOOL =
  "Shared memory: the `memory` tool reads and writes notes under `/memories` (`agent` is yours, `project/<slug>` and `org` are shared with your org). Before you start a task, search it (`action: search`) for the task's topic and read (`view`) the notes that apply; follow them unless the task says otherwise. Save durable facts you learn with `create`.";
const WITH_FILE =
  "Shared memory notes are in the file named by $HARNESS_MEMORY_FILE; read it before you start.";

const LESSONS_HEAD =
  "Lessons for this project and org. Your first step, before `task_checkout`, is to read each one with the `memory` tool (`action: view`, `path` as listed) and follow it unless the task says otherwise:";

// Path and title only: the body is for the agent to open, and a note could carry instructions.
// Project and org lessons are rules for all work there, so they are listed by recency, not by topic match.
function hints(
  db: Database,
  member: MemberRow,
  taskText: string,
  projectId: string | null,
): string {
  const viewer = agentViewer(db, member.id);
  const slugs = projectSlugs(db, member.orgId);
  const lessons = [
    ...(projectId === null
      ? []
      : searchNotes(db, viewer, { type: "lesson", scope: "project", projectId, limit: HITS })),
    ...searchNotes(db, viewer, { type: "lesson", scope: "org", limit: HITS }),
  ]
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, HITS);
  const listed = new Set(lessons.map((n) => n.id));
  const found = searchNotes(db, viewer, { text: taskText, anyWord: true, limit: HITS + HITS })
    .filter((n) => !listed.has(n.id))
    .slice(0, HITS);
  const title = (n: NoteSummary): string => n.title.replace(/\s+/g, " ");
  let out = "";
  if (lessons.length > 0) {
    const lines = lessons.map((n) => `- ${virtualPathOf(n, slugs)} — ${title(n)}`);
    out += `\n\n${LESSONS_HEAD}\n${lines.join("\n")}`;
  }
  if (found.length > 0) {
    const lines = found.map((n) => `- ${virtualPathOf(n, slugs)}: ${JSON.stringify(n.title)}`);
    out += `\n\nNotes that may apply:\n${lines.join("\n")}`;
  }
  return out;
}

// Org lessons are listed for every member; only a wake about a task adds a project's lessons.
export function wakeTaskProject(db: Database, wakes: WakeRow[]): string | null {
  for (const w of wakes) {
    const task = w.taskId === null ? null : getTask(db, w.taskId);
    if (task) return task.projectId;
  }
  return null;
}

// fileWritten is false when the run got no MEMORY.md, so the prompt must not point at one.
// Starts with a blank line when not empty, like the other prompt sections.
export function memoryNotice(
  db: Database,
  member: MemberRow,
  taskText: string,
  mcp: boolean,
  projectId: string | null = null,
  fileWritten = true,
): string {
  if (mcp) return `\n\n${WITH_TOOL}${hints(db, member, taskText, projectId)}`;
  const any = searchNotes(db, agentViewer(db, member.id), { limit: 1 }).length > 0;
  return any && fileWritten ? `\n\n${WITH_FILE}` : "";
}

// Task titles and wake excerpts are what the work is about, so they are the search text.
export function wakeTopic(db: Database, wakes: WakeRow[]): string {
  return wakes
    .map((w) => {
      const title = (w.taskId === null ? null : getTask(db, w.taskId))?.title ?? "";
      const excerpt = (w.detail as { excerpt?: unknown } | null)?.excerpt;
      return `${title} ${typeof excerpt === "string" ? excerpt : ""}`;
    })
    .join(" ");
}

// An engine without MCP cannot call the memory tool, so it gets the notes as a file instead.
export function memoryRun(
  db: Database,
  deps: ExecDeps,
  member: MemberRow,
  runtime: string,
  projectId: string | null,
  wakes: WakeRow[],
): { mcp: boolean; index: string | undefined } {
  const mcp = (deps.runDeps.resolveSpec ?? getSpec)(runtime)?.mcp ?? true;
  if (mcp) return { mcp, index: undefined };
  const slug = projectId === null ? null : (getProject(db, projectId)?.key ?? null);
  const text = buildMemoryIndex(db, agentViewer(db, member.id), slug, wakeTopic(db, wakes));
  return { mcp, index: text === "" ? undefined : text };
}
