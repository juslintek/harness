import type { Database } from "bun:sqlite";
import type { WsMessage } from "../shared/realtime";
import { onRunEvent } from "./features/runtimes/api";
import { onQuotaRecorded, onUsageRecorded } from "./features/usage/api";

// The dashboard totals come from runs, usage and quota, none of which ride another org message.
// Quota and tail usage belong to the whole instance, so they reach only the org topics that have
// a socket open right now; the rest refetch on load.
export function wireDashboardNudges(
  db: Database,
  send: (topic: string, message: WsMessage) => void,
  openOrgTopics: () => string[],
): () => void {
  const nudge = (topics: string[]): void => {
    for (const topic of topics) send(topic, { type: "dashboard" });
  };
  // Same attribution as the budgets: the member that ran it, else the member it was charged to.
  const orgTopicOfRun = (runId: string | null, endedOnly = false): string[] => {
    if (runId === null) return [];
    const row = db
      .query<{ org_id: string; ended_at: number | null }, [string]>(
        `SELECT m.org_id, r.ended_at FROM runs r
         JOIN members m ON m.id = COALESCE(r.member_id, r.charged_to) WHERE r.id = ?`,
      )
      .get(runId);
    return row && (!endedOnly || row.ended_at !== null) ? [`org:${row.org_id}`] : [];
  };
  const offRun = onRunEvent((runId, e) => {
    if (e.kind === "run") nudge(orgTopicOfRun(runId, true));
  });
  const offUsage = onUsageRecorded((runId) =>
    nudge(runId === null ? openOrgTopics() : orgTopicOfRun(runId)),
  );
  const offQuota = onQuotaRecorded(() => nudge(openOrgTopics()));
  return () => {
    offRun();
    offUsage();
    offQuota();
  };
}
