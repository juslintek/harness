import type { Database } from "bun:sqlite";
import type { Session, SessionMethod } from "./sessions";
import { sha256Hex } from "./sessions";

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * DAY_MS;
const SLIDE_EVERY_MS = 60 * 60 * 1000;

export interface MobileDeviceRecord {
  id: string;
  userId: string;
  sessionId: string;
  name: string;
  platform: "ios" | "android";
  publicKeySpki: string;
  createdAt: number;
  lastUsedAt: number;
}

interface MobileSessionRow {
  id: string;
  user_id: string;
  method: SessionMethod;
  step_up_at: number | null;
  last_seen_at: number;
  instance_admin: number;
  device_id: string;
}

export function sessionFromMobileToken(db: Database, token: string): Session | null {
  const now = Date.now();
  const tokenHash = sha256Hex(token);
  const row = db
    .query<MobileSessionRow, [string, number]>(
      `SELECT s.id, s.user_id, s.method, s.step_up_at, s.last_seen_at, u.instance_admin, d.id AS device_id
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN mobile_devices d ON d.session_id = s.id
        WHERE s.token_hash = ? AND s.method = 'mobile' AND s.revoked_at IS NULL AND s.expires_at > ?`,
    )
    .get(tokenHash, now);
  if (!row) return null;
  if (now - row.last_seen_at >= SLIDE_EVERY_MS) {
    db.run("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?", [
      now,
      now + SESSION_TTL_MS,
      row.id,
    ]);
    db.run("UPDATE mobile_devices SET last_used_at = ? WHERE id = ?", [now, row.device_id]);
  }
  return {
    id: row.id,
    userId: row.user_id,
    method: row.method,
    stepUpAt: row.step_up_at,
    instanceAdmin: row.instance_admin === 1,
  };
}

export function createMobileSession(
  db: Database,
  userId: string,
  token: string,
  userAgent: string | null,
): { id: string } {
  const id = Bun.randomUUIDv7();
  const now = Date.now();
  db.run(
    `INSERT INTO sessions
       (id, user_id, token_hash, method, user_agent, created_at, last_seen_at, expires_at, step_up_at)
     VALUES (?, ?, ?, 'mobile', ?, ?, ?, ?, ?)`,
    [id, userId, sha256Hex(token), userAgent, now, now, now + SESSION_TTL_MS, now],
  );
  return { id };
}

export function insertMobileDevice(
  db: Database,
  data: {
    userId: string;
    sessionId: string;
    name: string;
    platform: "ios" | "android";
    publicKeySpki: string;
  },
): string {
  const id = Bun.randomUUIDv7();
  const now = Date.now();
  db.run(
    `INSERT INTO mobile_devices
       (id, user_id, session_id, name, platform, public_key_spki, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, data.userId, data.sessionId, data.name, data.platform, data.publicKeySpki, now, now],
  );
  return id;
}

export function insertMobileChallenge(
  db: Database,
  data: {
    purpose: "enroll" | "pair" | "step_up";
    nonce: string;
    userId?: string | null;
    deviceId?: string | null;
    codeHash?: string | null;
    ttlMs: number;
  },
): { id: string; expiresAt: number } {
  const id = Bun.randomUUIDv7();
  const now = Date.now();
  const expiresAt = now + data.ttlMs;
  db.run(
    `INSERT INTO mobile_challenges
       (id, purpose, nonce, user_id, device_id, code_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.purpose,
      data.nonce,
      data.userId ?? null,
      data.deviceId ?? null,
      data.codeHash ?? null,
      expiresAt,
    ],
  );
  return { id, expiresAt };
}

export interface MobileChallengeRow {
  id: string;
  purpose: string;
  nonce: string;
  user_id: string | null;
  device_id: string | null;
  code_hash: string | null;
}

export function getLiveChallenge(
  db: Database,
  id: string,
  purpose: "enroll" | "pair" | "step_up",
): MobileChallengeRow | null {
  return db
    .query<MobileChallengeRow, [string, string, number]>(
      "SELECT id, purpose, nonce, user_id, device_id, code_hash FROM mobile_challenges WHERE id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?",
    )
    .get(id, purpose, Date.now());
}

export function consumeChallenge(
  db: Database,
  id: string,
  purpose: "enroll" | "pair" | "step_up",
): boolean {
  const now = Date.now();
  return (
    db.run(
      "UPDATE mobile_challenges SET used_at = ? WHERE id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?",
      [now, id, purpose, now],
    ).changes === 1
  );
}

export function insertPairCode(db: Database, userId: string, code: string, ttlMs: number): number {
  const now = Date.now();
  const expiresAt = now + ttlMs;
  db.run(
    "INSERT INTO mobile_pair_codes (code_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    [sha256Hex(code), userId, now, expiresAt],
  );
  return expiresAt;
}

export function getLivePairCode(
  db: Database,
  code: string,
): { codeHash: string; userId: string } | null {
  const row = db
    .query<{ code_hash: string; user_id: string }, [string, number]>(
      "SELECT code_hash, user_id FROM mobile_pair_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
    )
    .get(sha256Hex(code), Date.now());
  return row ? { codeHash: row.code_hash, userId: row.user_id } : null;
}

export function consumePairCode(db: Database, codeHash: string): boolean {
  const now = Date.now();
  return (
    db.run(
      "UPDATE mobile_pair_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
      [now, codeHash, now],
    ).changes === 1
  );
}

export function listMobileDevices(
  db: Database,
  userId: string,
): Array<{
  id: string;
  name: string;
  platform: "ios" | "android";
  createdAt: number;
  lastUsedAt: number;
  sessionId: string;
}> {
  const now = Date.now();
  return db
    .query<
      {
        id: string;
        name: string;
        platform: "ios" | "android";
        created_at: number;
        last_used_at: number;
        session_id: string;
      },
      [string, number]
    >(
      `SELECT md.id, md.name, md.platform, md.created_at, md.last_used_at, md.session_id
         FROM mobile_devices md
         JOIN sessions s ON s.id = md.session_id
        WHERE md.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?
        ORDER BY md.created_at DESC`,
    )
    .all(userId, now)
    .map((r) => ({
      id: r.id,
      name: r.name,
      platform: r.platform,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      sessionId: r.session_id,
    }));
}

export function getMobileDeviceForSession(
  db: Database,
  sessionId: string,
  userId: string,
): MobileDeviceRecord | null {
  const r = db
    .query<
      {
        id: string;
        user_id: string;
        session_id: string;
        name: string;
        platform: "ios" | "android";
        public_key_spki: string;
        created_at: number;
        last_used_at: number;
      },
      [string, string]
    >(
      "SELECT id, user_id, session_id, name, platform, public_key_spki, created_at, last_used_at FROM mobile_devices WHERE session_id = ? AND user_id = ?",
    )
    .get(sessionId, userId);
  return r
    ? {
        id: r.id,
        userId: r.user_id,
        sessionId: r.session_id,
        name: r.name,
        platform: r.platform,
        publicKeySpki: r.public_key_spki,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
      }
    : null;
}

export function getMobileDeviceById(
  db: Database,
  id: string,
  userId: string,
): { id: string; sessionId: string } | null {
  const r = db
    .query<{ id: string; session_id: string }, [string, string]>(
      "SELECT id, session_id FROM mobile_devices WHERE id = ? AND user_id = ?",
    )
    .get(id, userId);
  return r ? { id: r.id, sessionId: r.session_id } : null;
}

export function deleteMobileDevice(db: Database, id: string, userId: string): boolean {
  return (
    db.run("DELETE FROM mobile_devices WHERE id = ? AND user_id = ?", [id, userId]).changes > 0
  );
}

export function recordStepUp(db: Database, sessionId: string, deviceId: string): number {
  const now = Date.now();
  db.run("UPDATE sessions SET step_up_at = ? WHERE id = ?", [now, sessionId]);
  db.run("UPDATE mobile_devices SET last_used_at = ? WHERE id = ?", [now, deviceId]);
  return now;
}
