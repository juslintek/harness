import type { Database } from "bun:sqlite";
import type { ApprovalView } from "../../../shared/runs";
import { type ChatEvent, onMessage } from "../chat/api";
import { onApprovalChange } from "../guard/api";
import { redact } from "../logs/api";
import { getOrg } from "../orgs/api";
import { onRunEvent } from "../runtimes/api";
import type { Dispatcher } from "./dispatcher";
import { approvalRecipients, chatRecipients, orgAdmins, runOrgId } from "./recipients";

type Send = Dispatcher["notify"];

const BODY_MAX = 200;
const clip = (text: string): string => {
  const safe = redact(text);
  return safe.length > BODY_MAX ? `${safe.slice(0, BODY_MAX - 1)}…` : safe;
};

function onApproval(db: Database, send: Send, a: ApprovalView): void {
  if (a.status !== "pending") return;
  const orgId = runOrgId(db, a.runId);
  if (orgId === null) return;
  send(approvalRecipients(db, a), {
    kind: "approval_requested",
    orgId,
    title: "Approval needed",
    body: a.reason ? `${clip(a.command)}\n${a.reason}` : clip(a.command),
    path: `/#/approvals/${a.id}`,
    tag: `approval:${a.id}`,
  });
}

function onChat(db: Database, send: Send, e: ChatEvent): void {
  const { dm, mention } = chatRecipients(db, e);
  const slug = getOrg(db, e.channel.orgId)?.slug;
  if (slug === undefined) return;
  const from = e.message.author?.displayName ?? "Harness";
  const base = {
    orgId: e.channel.orgId,
    body: clip(e.message.body),
    path: `/#/o/${slug}/chat`,
    tag: `message:${e.message.id}`,
  };
  send(dm, { ...base, kind: "dm", title: `Message from ${from}` });
  send(mention, { ...base, kind: "mention", title: `${from} mentioned you in ${e.channel.name}` });
}

// The manager reports an ended run as "<state>" or "<state>: <reason>" in a run event body.
function onRun(db: Database, send: Send, runId: string, kind: string, body?: string): void {
  if (kind !== "run" || !body?.startsWith("blocked")) return;
  const orgId = runOrgId(db, runId);
  if (orgId === null) return;
  send(orgAdmins(db, orgId), {
    kind: "run_blocked",
    orgId,
    title: "Run blocked",
    body: clip(`Run ${runId} ${body}`),
    path: `/#/runs/${runId}`,
    tag: `run:${runId}`,
  });
}

export function subscribeEvents(db: Database, send: Send): () => void {
  const stops = [
    onApprovalChange((a) => onApproval(db, send, a)),
    onMessage((e) => onChat(db, send, e)),
    onRunEvent((runId, e) => onRun(db, send, runId, e.kind, e.body)),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
