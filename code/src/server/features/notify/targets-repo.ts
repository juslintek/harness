import type { Database } from "bun:sqlite";
import type { Channel, Target, TargetView } from "../../../shared/notify";
import { deleteSecret } from "../agents/api";

interface Raw {
  id: string;
  member_id: string;
  channel: Channel;
  value: string;
}

const toTarget = (r: Raw): Target => ({
  id: r.id,
  channel: r.channel,
  memberId: r.member_id,
  value: JSON.parse(r.value) as Record<string, string>,
});

// Re-adding the same value (a push resubscribe, a retried form) returns the existing row.
export function insertTarget(
  db: Database,
  memberId: string,
  channel: Channel,
  value: Record<string, string>,
  id: string = Bun.randomUUIDv7(),
): string {
  const json = JSON.stringify(value);
  const same = db
    .query<{ id: string }, [string, string, string]>(
      "SELECT id FROM notify_targets WHERE member_id = ? AND channel = ? AND value = ?",
    )
    .get(memberId, channel, json);
  if (same) return same.id;
  db.query(
    "INSERT INTO notify_targets (id, member_id, channel, value, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, memberId, channel, json, Date.now());
  return id;
}

export function targetsOf(db: Database, memberId: string, channel?: Channel): Target[] {
  const rows = channel
    ? db
        .query<Raw, [string, string]>(
          "SELECT * FROM notify_targets WHERE member_id = ? AND channel = ? ORDER BY created_at, id",
        )
        .all(memberId, channel)
    : db
        .query<Raw, [string]>(
          "SELECT * FROM notify_targets WHERE member_id = ? ORDER BY created_at, id",
        )
        .all(memberId);
  return rows.map(toTarget);
}

// A webhook's signing secret lives in secrets.json, so it goes with the row.
export function deleteTarget(
  db: Database,
  memberId: string,
  targetId: string,
  home?: string,
): boolean {
  const row = db
    .query<Raw, [string, string]>("SELECT * FROM notify_targets WHERE id = ? AND member_id = ?")
    .get(targetId, memberId);
  if (!row) return false;
  db.query("DELETE FROM notify_targets WHERE id = ?").run(targetId);
  if (row.channel === "webhook") {
    deleteSecret(toTarget(row).value.secretName ?? `webhook.${targetId}`, home);
  }
  return true;
}

function pushHost(endpoint: string | undefined): string {
  try {
    return new URL(endpoint ?? "").host;
  } catch {
    return "browser";
  }
}

// The label never carries a secret: a webhook shows its url, a push subscription only its host.
export function viewOf(t: Target): TargetView {
  const v = t.value;
  const label: Record<Channel, string> = {
    push: pushHost(v.endpoint),
    email: v.address ?? "",
    slack: v.userId ?? "",
    telegram: v.chatId ?? "",
    webhook: v.url ?? "",
  };
  return { id: t.id, channel: t.channel, label: label[t.channel] };
}
