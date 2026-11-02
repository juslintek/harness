import type { Database } from "bun:sqlite";

export type TokenScope = "report" | "guard_hook";

export interface RunIdentity {
  runId: string;
  scopes: TokenScope[];
}

function sha256Hex(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export function mint(db: Database, runId: string, scopes: TokenScope[]): string {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  db.query(
    "INSERT INTO run_tokens (hash, run_id, scopes, created_at) VALUES ($hash, $runId, $scopes, $now)",
  ).run({
    hash: sha256Hex(token),
    runId,
    scopes: JSON.stringify(scopes),
    now: Date.now(),
  });
  return token;
}

// Lookup by hash of the presented token: the raw token is never stored or compared directly.
export function verify(db: Database, token: string): RunIdentity | null {
  const row = db
    .query<{ run_id: string; scopes: string }, { hash: string }>(
      "SELECT run_id, scopes FROM run_tokens WHERE hash = $hash AND revoked_at IS NULL",
    )
    .get({ hash: sha256Hex(token) });
  if (!row) return null;
  return { runId: row.run_id, scopes: JSON.parse(row.scopes) as TokenScope[] };
}

export function revoke(db: Database, runId: string): void {
  db.query(
    "UPDATE run_tokens SET revoked_at = $now WHERE run_id = $runId AND revoked_at IS NULL",
  ).run({ now: Date.now(), runId });
}
