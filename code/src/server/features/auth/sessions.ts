import type { Database } from "bun:sqlite";

export type SessionMethod = "passkey" | "email" | "recovery" | "enroll";

export interface Session {
  id: string;
  userId: string;
  method: SessionMethod;
  stepUpAt: number | null;
  instanceAdmin: boolean;
}

export interface SessionInfo {
  id: string;
  method: SessionMethod;
  userAgent: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * DAY_MS;
const SLIDE_EVERY_MS = 60 * 60 * 1000;
const STEP_UP_MS = 5 * 60 * 1000;

export function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

// Recovery and enrollment prove possession of a one-time secret, so the user may add a passkey
// at once; an email code is weaker and never unlocks dangerous actions.
export function createSession(
  db: Database,
  userId: string,
  method: SessionMethod,
  userAgent: string | null,
): { token: string; id: string } {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const id = Bun.randomUUIDv7();
  const now = Date.now();
  db.query(
    `INSERT INTO sessions
       (id, user_id, token_hash, method, user_agent, created_at, last_seen_at, expires_at, step_up_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    sha256Hex(token),
    method,
    userAgent,
    now,
    now,
    now + SESSION_TTL_MS,
    method === "recovery" || method === "enroll" ? now : null,
  );
  return { token, id };
}

interface SessionRow {
  id: string;
  user_id: string;
  method: SessionMethod;
  step_up_at: number | null;
  last_seen_at: number;
  instance_admin: number;
}

// The lookup key is the hash of the presented token, so the raw token is never compared directly.
export function sessionFromToken(db: Database, token: string): Session | null {
  const now = Date.now();
  const row = db
    .query<SessionRow, [string, number]>(
      `SELECT s.id, s.user_id, s.method, s.step_up_at, s.last_seen_at, u.instance_admin
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    )
    .get(sha256Hex(token), now);
  if (!row) return null;
  if (now - row.last_seen_at >= SLIDE_EVERY_MS) {
    db.query("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(
      now,
      now + SESSION_TTL_MS,
      row.id,
    );
  }
  return {
    id: row.id,
    userId: row.user_id,
    method: row.method,
    stepUpAt: row.step_up_at,
    instanceAdmin: row.instance_admin === 1,
  };
}

export function listSessions(db: Database, userId: string): SessionInfo[] {
  return db
    .query<
      {
        id: string;
        method: SessionMethod;
        user_agent: string | null;
        created_at: number;
        last_seen_at: number;
        expires_at: number;
      },
      [string, number]
    >(
      `SELECT id, method, user_agent, created_at, last_seen_at, expires_at FROM sessions
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
    )
    .all(userId, Date.now())
    .map((row) => ({
      id: row.id,
      method: row.method,
      userAgent: row.user_agent,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
    }));
}

const sessionRevoked = new Set<(sessionId: string) => void>();

// Live connections (WebSockets) authenticated by a session must end when the session does.
export function onSessionRevoked(fn: (sessionId: string) => void): () => void {
  sessionRevoked.add(fn);
  return () => sessionRevoked.delete(fn);
}

export function revokeSession(db: Database, userId: string, sessionId: string): boolean {
  const revoked =
    db
      .query(
        "UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
      )
      .run(Date.now(), sessionId, userId).changes > 0;
  if (revoked) for (const fn of sessionRevoked) fn(sessionId);
  return revoked;
}

export function hasFreshStepUp(session: Session, now: number = Date.now()): boolean {
  return session.stepUpAt !== null && now - session.stepUpAt < STEP_UP_MS;
}
