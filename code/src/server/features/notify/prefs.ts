import type { Database } from "bun:sqlite";
import {
  CHANNELS,
  type Channel,
  NOTIFY_KINDS,
  type NotifyKind,
  type PrefView,
} from "../../../shared/notify";

const DEFAULT_ON: ReadonlySet<string> = new Set([
  "push:approval_requested",
  "email:approval_requested",
  "push:mention",
  "push:dm",
]);

const defaultEnabled = (channel: Channel, kind: NotifyKind): boolean =>
  DEFAULT_ON.has(`${channel}:${kind}`);

export function isEnabled(
  db: Database,
  memberId: string,
  channel: Channel,
  kind: NotifyKind,
): boolean {
  const row = db
    .query<{ enabled: number }, [string, string, string]>(
      "SELECT enabled FROM notify_prefs WHERE member_id = ? AND channel = ? AND kind = ?",
    )
    .get(memberId, channel, kind);
  return row ? row.enabled === 1 : defaultEnabled(channel, kind);
}

export function effectivePrefs(db: Database, memberId: string): PrefView[] {
  const rows = db
    .query<{ channel: string; kind: string; enabled: number }, [string]>(
      "SELECT channel, kind, enabled FROM notify_prefs WHERE member_id = ?",
    )
    .all(memberId);
  const stored = new Map(rows.map((r) => [`${r.channel}:${r.kind}`, r.enabled === 1]));
  return CHANNELS.flatMap((channel) =>
    NOTIFY_KINDS.map((kind) => ({
      channel,
      kind,
      enabled: stored.get(`${channel}:${kind}`) ?? defaultEnabled(channel, kind),
    })),
  );
}

export function setPref(
  db: Database,
  memberId: string,
  channel: Channel,
  kind: NotifyKind,
  enabled: boolean,
): void {
  db.query(
    `INSERT INTO notify_prefs (member_id, channel, kind, enabled) VALUES (?, ?, ?, ?)
     ON CONFLICT (member_id, channel, kind) DO UPDATE SET enabled = excluded.enabled`,
  ).run(memberId, channel, kind, enabled ? 1 : 0);
}
