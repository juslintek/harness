import {
  type MoveFailure,
  moveFailureSchema,
  type Status,
  type TaskView,
  taskViewSchema,
} from "../../../shared/board";

export type Outcome = { ok: true; task: TaskView } | { ok: false; message: string };

export const STATUS_LABEL: Record<Status, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

const numbers = (open: number[]): string => open.map((n) => `#${n}`).join(", ");

function failureText(f: MoveFailure, handleOf: (memberId: string) => string): string {
  if (f.reason === "held") return `held by @${handleOf(f.holderId)}`;
  if (f.reason === "deps_open") return `waiting on ${numbers(f.open)}`;
  if (f.reason === "children_open") return `subtasks open: ${numbers(f.open)}`;
  return "task is not available for this action";
}

// The api() helper only surfaces an error string; the 409 body carries the reason, so these calls read it directly.
export async function postTaskAction(
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
  if (res.status === 401 && !/^#\/(login|enroll)/.test(location.hash)) location.hash = "#/login";
  if (res.ok) return { ok: true, task: taskViewSchema.parse(json) };
  const failure = moveFailureSchema.safeParse(json);
  if (failure.success) return { ok: false, message: failureText(failure.data, handleOf) };
  const text =
    typeof json === "object" && json !== null && "error" in json ? String(json.error) : "";
  return { ok: false, message: text || `HTTP ${res.status}` };
}
