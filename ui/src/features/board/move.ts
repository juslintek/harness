import {
  type MoveFailure,
  moveFailureSchema,
  type Status,
  type TaskView,
  taskViewSchema,
} from "@shared/board";
import { rememberReturn } from "../../return-hash";
import { statusWord } from "../../ui/atoms/status";

export const STATUSES: Status[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
];

export type Outcome = { ok: true; task: TaskView } | { ok: false; message: string };

const numbers = (open: number[]): string => open.map((n) => `#${n}`).join(", ");

export function failureText(f: MoveFailure, handleOf: (memberId: string) => string): string {
  if (f.reason === "held") return `Held by @${handleOf(f.holderId)}, so only they can change it.`;
  if (f.reason === "deps_open")
    return `Not allowed yet: it depends on ${numbers(f.open)}, still open.`;
  if (f.reason === "children_open")
    return `Not allowed yet: subtasks ${numbers(f.open)} are still open.`;
  return "This task is not available for this action.";
}

// api() only keeps the error string, and the 409 body carries the reason, so these calls read it directly.
export async function postTask(
  path: string,
  body: unknown,
  handleOf: (memberId: string) => string,
): Promise<Outcome> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => null);
  if (res.status === 401 && !/^#\/(login|enroll)/.test(location.hash)) {
    rememberReturn(location.hash);
    location.hash = "#/login";
  }
  if (res.ok) return { ok: true, task: taskViewSchema.parse(json) };
  const failure = moveFailureSchema.safeParse(json);
  if (failure.success) return { ok: false, message: failureText(failure.data, handleOf) };
  const text =
    typeof json === "object" && json !== null && "error" in json ? String(json.error) : "";
  return { ok: false, message: text || `HTTP ${res.status}` };
}

export interface Notice {
  taskId: string;
  text: string;
}

// The plain word for a status, as DESIGN.md asks: "in progress", not "in_progress".
export const statusLabel = (status: Status): string => statusWord(status).word;
