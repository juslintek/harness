import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";

export const INVITE_TTL_MS: number = 15 * 60_000;

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

export function createInvite(
  db: Database,
  userId: string,
  now: number = Date.now(),
): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now + INVITE_TTL_MS;
  db.run("INSERT INTO fed_invites (hash, created_by, expires_at) VALUES (?, ?, ?)", [
    hashOf(token),
    userId,
    expiresAt,
  ]);
  return { token, expiresAt };
}

// One UPDATE decides, so two concurrent pair calls with the same token cannot both win.
export function consumeInvite(db: Database, token: string, now: number = Date.now()): boolean {
  return (
    db.run(
      "UPDATE fed_invites SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ?",
      [now, hashOf(token), now],
    ).changes === 1
  );
}
