import type { Database } from "bun:sqlite";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Context } from "hono";
import { type WsMessage, wsTopicSchema } from "../shared/realtime";
import { type AuthEnv, onSessionRevoked, sessionExpiresAt } from "./features/auth/api";
import { onTaskChange } from "./features/board/api";
import { channelMembers, onMessage } from "./features/chat/api";
import { onApprovalChange } from "./features/guard/api";
import { getProject, listGrantOrgIds, onMemberRemoved, orgAccess } from "./features/orgs/api";
import { getRun, onRunEvent } from "./features/runtimes/api";
import { viewRun } from "./features/runtimes/routes";
import { wireDashboardNudges } from "./realtime-dashboard";

export interface WsData {
  topic: string;
  sessionId: string;
  userId: string;
  expiresAt: number;
}

// Access is checked once at the upgrade, so sockets are tracked to be closed when it ends.
const sockets = new Set<ServerWebSocket<WsData>>();

function closeWhere(match: (data: WsData) => boolean): void {
  for (const ws of sockets) if (match(ws.data)) ws.close(4401, "access ended");
}

const SWEEP_MS = 60_000;

// Sessions slide forward on other requests, so a socket past the expiry it saw is re-checked
// against the db before it is closed.
function sweepExpired(db: Database): void {
  const now = Date.now();
  for (const ws of sockets) {
    if (ws.data.expiresAt > now) continue;
    const current = sessionExpiresAt(db, ws.data.sessionId);
    if (current === null) ws.close(4401, "session expired");
    else ws.data.expiresAt = current;
  }
}

export const websocket: WebSocketHandler<WsData> = {
  open(ws) {
    sockets.add(ws);
    ws.subscribe(ws.data.topic);
  },
  close(ws) {
    sockets.delete(ws);
  },
  // Clients only listen; anything they send is ignored and the frame size is capped.
  message() {},
  maxPayloadLength: 1024,
  idleTimeout: 120,
};

// Runs behind hostGuard, the session and originGuard. Run topics stay admin-only; an org topic
// is open to any member of that org, whatever their role.
export function wsUpgrade(db: Database): (c: Context<AuthEnv>) => Response {
  return (c) => {
    const topic = wsTopicSchema.safeParse(c.req.query("topic"));
    if (!topic.success) return c.json({ error: "invalid topic" }, 400);
    const actor = c.get("actor");
    const orgId = topic.data.startsWith("org:") ? topic.data.slice(4) : null;
    const allowed = orgId ? orgAccess(db, actor.userId, orgId) !== null : actor.instanceAdmin;
    if (!allowed) return c.json({ error: "forbidden" }, 403);
    const env = c.env as { server?: Server<WsData> } | undefined;
    const expiresAt = sessionExpiresAt(db, actor.id);
    if (expiresAt === null) return c.json({ error: "session expired" }, 401);
    const data = { topic: topic.data, sessionId: actor.id, userId: actor.userId, expiresAt };
    if (!env?.server?.upgrade(c.req.raw, { data })) {
      return c.json({ error: "upgrade failed" }, 426);
    }
    return new Response(null);
  };
}

// A shared project is visible to its owner org and every grantee org.
function projectTopics(db: Database, projectId: string): string[] {
  const project = getProject(db, projectId);
  if (!project) return [];
  return [project.orgId, ...listGrantOrgIds(db, projectId)].map((id) => `org:${id}`);
}

type Send = (topic: string, message: WsMessage) => void;

function nudgeChat(
  db: Database,
  send: Send,
  { message, channel }: Parameters<Parameters<typeof onMessage>[0]>[0],
): void {
  const nudge: WsMessage = {
    type: "chat",
    channelId: channel.id,
    messageId: message.id,
    threadRootId: message.threadRootId,
  };
  if (channel.kind === "group" || channel.kind === "dm") {
    // An org topic reaches every member, so a private conversation is sent socket by socket.
    const userIds = new Set(channelMembers(db, channel).map((m) => m.userId));
    const text = JSON.stringify(nudge);
    for (const ws of sockets) {
      if (ws.data.topic.startsWith("org:") && userIds.has(ws.data.userId)) ws.send(text);
    }
    return;
  }
  const topics = channel.projectId
    ? projectTopics(db, channel.projectId)
    : [`org:${channel.orgId}`];
  for (const topic of topics) send(topic, nudge);
}

export function wireRealtime(
  db: Database,
  server: Server<WsData>,
  sweepMs: number = SWEEP_MS,
): () => void {
  const send = (topic: string, message: WsMessage): void => {
    server.publish(topic, JSON.stringify(message));
  };
  const offRun = onRunEvent((runId, e) => {
    send(`run:${runId}`, { type: "event", runId, event: { kind: e.kind, ts: e.ts ?? null } });
    const row = getRun(db, runId);
    if (row) send("runs", { type: "run", run: viewRun(db, row) });
  });
  const offApproval = onApprovalChange((approval) => {
    send("approvals", { type: "approval", approval });
    send(`run:${approval.runId}`, {
      type: "event",
      runId: approval.runId,
      event: { kind: "approval", ts: null },
    });
  });
  const offTask = onTaskChange((change) => {
    const message: WsMessage = {
      type: "task",
      projectId: change.task.projectId,
      taskId: change.task.id,
      kind: change.kind,
    };
    for (const topic of projectTopics(db, change.task.projectId)) send(topic, message);
  });
  const offChat = onMessage((e) => nudgeChat(db, send, e));
  const offSession = onSessionRevoked((sessionId) => closeWhere((d) => d.sessionId === sessionId));
  const offMember = onMemberRemoved((_db, member) =>
    closeWhere((d) => d.userId === member.userId && d.topic === `org:${member.orgId}`),
  );
  const offDashboard = wireDashboardNudges(db, send, () => [
    ...new Set([...sockets].map((ws) => ws.data.topic).filter((t) => t.startsWith("org:"))),
  ]);
  const sweeper = setInterval(() => sweepExpired(db), sweepMs);
  sweeper.unref();
  return () => {
    clearInterval(sweeper);
    offSession();
    offMember();
    offRun();
    offApproval();
    offTask();
    offChat();
    offDashboard();
  };
}
