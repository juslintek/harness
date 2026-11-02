import type { Database } from "bun:sqlite";

export type TokenScope = "report" | "guard_hook" | "board" | "chat" | "approvals_decide";

export interface RunIdentity {
  runId: string;
  scopes: TokenScope[];
  memberId: string | null;
  orgId: string | null;
}

function sha256Hex(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export function mint(
  db: Database,
  runId: string,
  scopes: TokenScope[],
  member?: { memberId: string; orgId: string },
): string {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  db.query(
    `INSERT INTO run_tokens (hash, run_id, scopes, created_at, member_id, org_id)
     VALUES ($hash, $runId, $scopes, $now, $memberId, $orgId)`,
  ).run({
    hash: sha256Hex(token),
    runId,
    scopes: JSON.stringify(scopes),
    now: Date.now(),
    memberId: member?.memberId ?? null,
    orgId: member?.orgId ?? null,
  });
  return token;
}

// Lookup by hash of the presented token: the raw token is never stored or compared directly.
export function verify(db: Database, token: string): RunIdentity | null {
  const row = db
    .query<
      { run_id: string; scopes: string; member_id: string | null; org_id: string | null },
      { hash: string }
    >("SELECT run_id, scopes, member_id, org_id FROM run_tokens WHERE hash = $hash")
    .get({ hash: sha256Hex(token) });
  if (!row) return null;
  return {
    runId: row.run_id,
    scopes: JSON.parse(row.scopes) as TokenScope[],
    memberId: row.member_id,
    orgId: row.org_id,
  };
}

// Deleted rather than flagged: a finished run's token has no further use and the audit trail
// lives in the event log. verify() finds nothing for a deleted hash, same as for a revoked one.
export function revoke(db: Database, runId: string): void {
  db.query("DELETE FROM run_tokens WHERE run_id = $runId").run({ runId });
}
