import type { Database } from "bun:sqlite";
import type { WakeReason } from "../../../shared/heartbeat";
import { getComment, getTask, type TaskChange } from "../board/api";
import { type ChatEvent, channelAccess, channelMembers, getChannel } from "../chat/api";
import type { triageWake } from "../laya/api";
import { appendEvent } from "../logs/api";
import { getMember, type MemberRow, projectAccess } from "../orgs/api";
import { contextForMember, effective } from "../policies/api";
import { insertWake, scheduleCandidates, startedRunsSince } from "./repo";

const HOUR_MS = 3_600_000;
const EXCERPT_CHARS = 500;

interface WakeInput {
  memberId: string;
  reason: WakeReason;
  taskId?: string | undefined;
  channelId?: string | undefined;
  messageId?: string | undefined;
  detail?: unknown;
  causedBy: string | null;
}

// One error event per member and hour is enough to show a cap or a budget pause was hit.
const logged = new WeakMap<Database, Map<string, number>>();

function logOncePerHour(db: Database, key: string, body: string, now: number): void {
  const seen = logged.get(db) ?? new Map<string, number>();
  logged.set(db, seen);
  if (now - (seen.get(key) ?? 0) < HOUR_MS) return;
  seen.set(key, now);
  appendEvent(db, { kind: "error", source: "heartbeat", body });
}

const capOf = (db: Database, memberId: string): number =>
  effective(db, contextForMember(db, memberId), "heartbeat.maxRunsPerHour").value;

function logCap(db: Database, member: MemberRow, now: number): void {
  const body = `wake cap reached: @${member.handle} already had ${capOf(db, member.id)} runs in the last hour`;
  logOncePerHour(db, `cap:${member.id}`, body, now);
}

export function logBudgetPaused(db: Database, member: MemberRow): void {
  const body = `runs skipped: a budget covering @${member.handle} is spent`;
  logOncePerHour(db, `budget:${member.id}`, body, Date.now());
}

export class WakeCapError extends Error {
  constructor() {
    super("wake_cap");
    this.name = "WakeCapError";
  }
}

export function overCap(db: Database, memberId: string): boolean {
  return startedRunsSince(db, memberId, Date.now() - HOUR_MS) >= capOf(db, memberId);
}

function store(db: Database, member: MemberRow, input: WakeInput): string {
  const now = Date.now();
  if (overCap(db, member.id)) {
    logCap(db, member, now);
    const detail = { ...(input.detail as object | undefined), cap: "hourly" };
    return insertWake(db, { ...input, detail, status: "skipped" });
  }
  return insertWake(db, input);
}

// A task or project wake hands the agent that project's repo and text, so it needs write access
// there; any other channel only has to be readable. Grants change, so launch checks again.
export function mayWork(
  db: Database,
  memberId: string,
  wake: { taskId?: string | null | undefined; channelId?: string | null | undefined },
): boolean {
  if (wake.taskId) {
    const task = getTask(db, wake.taskId);
    if (!task) return false;
    const taskAccess = projectAccess(db, { memberId }, task.projectId);
    if (taskAccess !== "write" && taskAccess !== "admin") return false;
  }
  if (!wake.channelId) return true;
  const access = channelAccess(db, memberId, wake.channelId);
  return getChannel(db, wake.channelId)?.projectId ? access === "write" : access !== "none";
}

// An assignment or subtask wake stored earlier must not start work that was since finished or handed on.
export function staleAssignment(
  db: Database,
  memberId: string,
  wake: { reason: WakeReason; taskId?: string | null | undefined },
): boolean {
  if ((wake.reason !== "assignment" && wake.reason !== "subtask") || !wake.taskId) return false;
  const task = getTask(db, wake.taskId);
  if (!task) return true;
  return task.status === "done" || task.status === "cancelled" || task.assigneeId !== memberId;
}

// Agents only, never for their own doing, never while paused and never where they cannot work.
export function recordWake(db: Database, input: WakeInput): string | null {
  const member = getMember(db, input.memberId);
  if (member?.kind !== "agent" || member.paused) return null;
  if (input.causedBy === member.id || !mayWork(db, member.id, input)) return null;
  return store(db, member, input);
}

export class ViewerError extends Error {
  constructor() {
    super("viewer");
    this.name = "ViewerError";
  }
}

export function runNow(db: Database, memberId: string, causedBy: string, taskId?: string): string {
  const member = getMember(db, memberId);
  if (member?.kind !== "agent") throw new Error("not an agent member");
  if (member.paused) throw new Error("member is paused");
  // A viewer agent is not scheduled either, because a run would act with write scopes.
  if (member.role === "viewer") throw new ViewerError();
  if (overCap(db, memberId)) {
    logCap(db, member, Date.now());
    throw new WakeCapError();
  }
  return store(db, member, { memberId, reason: "run_now", causedBy, taskId });
}

const excerpt = (text: string): string => text.slice(0, EXCERPT_CHARS);

// The parent's assignee is the one who closes the parent, and nobody tells them a subtask is done.
function wakeParentAssignee(db: Database, change: TaskChange): void {
  const { task } = change;
  if (change.kind !== "moved" || change.from === task.status || task.parentId === null) return;
  if (!["in_review", "done", "cancelled"].includes(task.status)) return;
  const parent = getTask(db, task.parentId);
  if (!parent || parent.assigneeId === null) return;
  const detail = { excerpt: excerpt(`#${task.number} ${task.title} moved to ${task.status}`) };
  const input = { taskId: parent.id, causedBy: change.by, detail };
  recordWake(db, { ...input, memberId: parent.assigneeId, reason: "subtask" });
}

export function onTask(db: Database, change: TaskChange): void {
  const { task } = change;
  const base = { taskId: task.id, causedBy: change.by };
  // A task created with an assignee (a lead splitting work for a dev) is an assignment too.
  const assigns = change.kind === "assigned" || change.kind === "created";
  if (assigns && task.assigneeId !== null && task.assigneeId !== change.by) {
    recordWake(db, { ...base, memberId: task.assigneeId, reason: "assignment" });
  }
  wakeParentAssignee(db, change);
  if (change.kind !== "commented") return;
  const body = change.commentId === undefined ? undefined : getComment(db, change.commentId)?.body;
  const detail = body === undefined ? undefined : { excerpt: excerpt(body) };
  const targets = new Set([task.assigneeId, task.holderId]);
  for (const memberId of targets) {
    if (memberId !== null) recordWake(db, { ...base, memberId, reason: "comment", detail });
  }
}

export async function onChat(
  db: Database,
  event: ChatEvent,
  triage: typeof triageWake,
): Promise<void> {
  const { message, mentions, channel } = event;
  const author = message.authorId === null ? null : getMember(db, message.authorId);
  const base = { channelId: channel.id, messageId: message.id, causedBy: message.authorId };
  const detail = { excerpt: excerpt(message.body) };
  if (mentions.length > 0) {
    for (const memberId of mentions)
      recordWake(db, { ...base, memberId, reason: "mention", detail });
    return;
  }
  if (channel.kind !== "team" && channel.kind !== "project") return;
  // Agents talking among themselves must not wake each other through Laya.
  if (author?.kind === "agent") return;
  const result = await triage(message.body);
  if (result.specialty === null) return;
  const specialty = result.specialty;
  // A project channel is open to grantee orgs, so their agents are candidates too.
  for (const m of channelMembers(db, channel)) {
    if (m.kind !== "agent" || !m.specialties.includes(specialty)) continue;
    if (channelAccess(db, m.id, channel.id) !== "write") continue;
    recordWake(db, {
      ...base,
      memberId: m.id,
      reason: "laya_mention",
      detail: { ...detail, triage: result },
    });
  }
}

// One indexed read per tick; the rest is arithmetic on the rows it returns.
export function dueSchedules(db: Database, now: number): number {
  let made = 0;
  for (const c of scheduleCandidates(db)) {
    if (now - c.last < c.minutes * 60_000) continue;
    if (recordWake(db, { memberId: c.id, reason: "schedule", causedBy: null }) !== null) made++;
  }
  return made;
}
