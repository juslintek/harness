import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

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

const INVITE_FILE = "pair-invite";

// A deploy leaves a random code in <home>/pair-invite. Booting turns it into an ordinary one-time
// invite (only the hash is stored) and deletes the file, so the code lives in clear on disk only
// until the first start.
export function consumePairInvite(db: Database, home: string, now: number = Date.now()): boolean {
  const file = join(home, INVITE_FILE);
  if (!existsSync(file)) return false;
  const token = readFileSync(file, "utf8").trim();
  if (token) {
    db.run("INSERT OR IGNORE INTO fed_invites (hash, created_by, expires_at) VALUES (?, ?, ?)", [
      hashOf(token),
      "deploy",
      now + INVITE_TTL_MS,
    ]);
  }
  rmSync(file);
  return token.length > 0;
}
