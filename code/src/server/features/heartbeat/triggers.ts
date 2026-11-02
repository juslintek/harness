import type { Database } from "bun:sqlite";
import type { WakeReason } from "../../../shared/heartbeat";
import { getComment, getTask, type TaskChange } from "../board/api";
import { type ChatEvent, channelAccess, getChannel } from "../chat/api";
import type { triageWake } from "../laya/api";
import { appendEvent } from "../logs/api";
import { getMember, listMembers, type MemberRow, projectAccess } from "../orgs/api";
import { insertWake, scheduleCandidates, startedRunsSince } from "./repo";

const HOURLY_CAP = 20;
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

// One error event per member and hour is enough to show the cap was hit.
const capLogged = new WeakMap<Database, Map<string, number>>();

function logCap(db: Database, member: MemberRow, now: number): void {
  const seen = capLogged.get(db) ?? new Map<string, number>();
  capLogged.set(db, seen);
  if (now - (seen.get(member.id) ?? 0) < HOUR_MS) return;
  seen.set(member.id, now);
  appendEvent(db, {
    kind: "error",
    source: "heartbeat",
    body: `wake cap reached: @${member.handle} already had ${HOURLY_CAP} runs in the last hour`,
  });
}

export class WakeCapError extends Error {
  constructor() {
    super("wake_cap");
    this.name = "WakeCapError";
  }
}

export function overCap(db: Database, memberId: string): boolean {
  return startedRunsSince(db, memberId, Date.now() - HOUR_MS) >= HOURLY_CAP;
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
  const task = wake.taskId ? getTask(db, wake.taskId) : null;
  const taskAccess = task ? projectAccess(db, { memberId }, task.projectId) : "write";
  if (taskAccess !== "write" && taskAccess !== "admin") return false;
  if (!wake.channelId) return true;
  const access = channelAccess(db, memberId, wake.channelId);
  return getChannel(db, wake.channelId)?.projectId ? access === "write" : access !== "none";
}

// Agents only, never for their own doing, never while paused and never where they cannot work.
function recordWake(db: Database, input: WakeInput): string | null {
  const member = getMember(db, input.memberId);
  if (member?.kind !== "agent" || member.paused) return null;
  if (input.causedBy === member.id || !mayWork(db, member.id, input)) return null;
  return store(db, member, input);
}

export function runNow(db: Database, memberId: string, causedBy: string): string {
  const member = getMember(db, memberId);
  if (member?.kind !== "agent") throw new Error("not an agent member");
  if (member.paused) throw new Error("member is paused");
  if (overCap(db, memberId)) {
    logCap(db, member, Date.now());
    throw new WakeCapError();
  }
  return store(db, member, { memberId, reason: "run_now", causedBy });
}

const excerpt = (text: string): string => text.slice(0, EXCERPT_CHARS);

export function onTask(db: Database, change: TaskChange): void {
  const { task } = change;
  const base = { taskId: task.id, causedBy: change.by };
  if (change.kind === "assigned" && task.assigneeId !== null) {
    recordWake(db, { ...base, memberId: task.assigneeId, reason: "assignment" });
  }
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
  for (const m of listMembers(db, channel.orgId)) {
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
