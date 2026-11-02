import type { Database } from "bun:sqlite";
import type { Server, WebSocketHandler } from "bun";
import type { Context } from "hono";
import { type WsMessage, wsTopicSchema } from "../shared/runs";
import { onApprovalChange } from "./features/guard/api";
import { getRun, onRunEvent } from "./features/runtimes/api";
import { viewRun } from "./features/runtimes/routes";

export interface WsData {
  topic: string;
}

export const websocket: WebSocketHandler<WsData> = {
  open(ws) {
    ws.subscribe(ws.data.topic);
  },
  // Clients only listen; anything they send is ignored and the frame size is capped.
  message() {},
  maxPayloadLength: 1024,
  idleTimeout: 120,
};

// Runs behind hostGuard, adminMiddleware and originGuard, so only an admin browser tab gets here.
export function wsUpgrade(c: Context): Response {
  const topic = wsTopicSchema.safeParse(c.req.query("topic"));
  if (!topic.success) return c.json({ error: "invalid topic" }, 400);
  const env = c.env as { server?: Server<WsData> } | undefined;
  if (!env?.server?.upgrade(c.req.raw, { data: { topic: topic.data } })) {
    return c.json({ error: "upgrade failed" }, 426);
  }
  return new Response(null);
}

export function wireRealtime(db: Database, server: Server<WsData>): () => void {
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
  return () => {
    offRun();
    offApproval();
  };
}
