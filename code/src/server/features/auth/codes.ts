import type { Database } from "bun:sqlite";
import { randomInt } from "node:crypto";
import { safeEqual } from "./admin";
import { sha256Hex } from "./sessions";
import { countUsers, createUser, findUserByEmail } from "./users";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const MINUTE_MS = 60 * 1000;
const EMAIL_CODE_TTL_MS = 10 * MINUTE_MS;
const EMAIL_WINDOW_MS = 15 * MINUTE_MS;
const EMAIL_MAX_PER_WINDOW = 3;
const EMAIL_MAX_ATTEMPTS = 5;

// 32 symbols divide 256 evenly, so masking a random byte has no modulo bias.
function randomCode(groups: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(groups * 4));
  const chars = Array.from(bytes, (byte) => BASE32[byte & 31]);
  return Array.from({ length: groups }, (_, i) => chars.slice(i * 4, i * 4 + 4).join("")).join("-");
}

function normalizeCode(code: string): string {
  return code.trim().toLowerCase();
}

export function newRecoveryCodes(db: Database, userId: string): string[] {
  const codes = Array.from({ length: 10 }, () => randomCode(3));
  db.transaction(() => {
    db.query("DELETE FROM recovery_codes WHERE user_id = ?").run(userId);
    for (const code of codes) {
      db.query("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)").run(
        userId,
        sha256Hex(code),
      );
    }
  })();
  return codes;
}

export function useRecoveryCode(db: Database, email: string, code: string): string | null {
  const user = findUserByEmail(db, email);
  if (!user) return null;
  const used = db
    .query(
      "UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL",
    )
    .run(Date.now(), user.id, sha256Hex(normalizeCode(code)));
  return used.changes === 1 ? user.id : null;
}

// Unknown emails get a stored (never delivered) code, so the rate limit and the reply look the
// same whether or not the account exists.
export function requestEmailCode(
  db: Database,
  email: string,
  deliver: (email: string, code: string) => void,
): "sent" | "rate_limited" {
  const now = Date.now();
  const recent = db
    .query<{ n: number }, [string, number]>(
      "SELECT count(*) AS n FROM email_codes WHERE email = ? AND created_at > ?",
    )
    .get(email, now - EMAIL_WINDOW_MS)?.n;
  if ((recent ?? 0) >= EMAIL_MAX_PER_WINDOW) return "rate_limited";
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  db.transaction(() => {
    db.query("UPDATE email_codes SET used_at = ? WHERE email = ? AND used_at IS NULL").run(
      now,
      email,
    );
    db.query(
      "INSERT INTO email_codes (id, email, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).run(Bun.randomUUIDv7(), email, sha256Hex(code), now, now + EMAIL_CODE_TTL_MS);
  })();
  if (findUserByEmail(db, email)) deliver(email, code);
  return "sent";
}

export function verifyEmailCode(db: Database, email: string, code: string): string | null {
  const now = Date.now();
  const row = db
    .query<{ id: string; code_hash: string }, [string, number, number]>(
      `SELECT id, code_hash FROM email_codes
        WHERE email = ? AND used_at IS NULL AND expires_at > ? AND attempts < ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(email, now, EMAIL_MAX_ATTEMPTS);
  if (!row) return null;
  if (!safeEqual(row.code_hash, sha256Hex(code.trim()))) {
    db.query("UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?").run(row.id);
    return null;
  }
  db.query("UPDATE email_codes SET used_at = ? WHERE id = ?").run(now, row.id);
  return findUserByEmail(db, email)?.id ?? null;
}

// No user and no email marks the first-owner bootstrap code.
export function createEnrollment(
  db: Database,
  opts: { userId?: string; email?: string; ttlMs: number },
): string {
  const code = randomCode(4);
  const now = Date.now();
  db.query(
    "INSERT INTO enrollments (code_hash, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).run(sha256Hex(code), opts.userId ?? null, opts.email ?? null, now, now + opts.ttlMs);
  return code;
}

interface EnrollmentRow {
  user_id: string | null;
  email: string | null;
}

function userForEnrollment(
  db: Database,
  row: EnrollmentRow,
  profile: { email: string; name: string },
): string | null {
  if (row.user_id) return row.user_id;
  const bootstrap = row.email === null;
  if (bootstrap && countUsers(db) > 0) return null;
  if (row.email !== null && row.email.toLowerCase() !== profile.email.toLowerCase()) return null;
  if (findUserByEmail(db, profile.email)) return null;
  return createUser(db, { ...profile, instanceAdmin: bootstrap });
}

export function redeemEnrollment(
  db: Database,
  code: string,
  profile: { email: string; name: string },
): string | null {
  return db.transaction((): string | null => {
    const hash = sha256Hex(normalizeCode(code));
    const now = Date.now();
    const row = db
      .query<EnrollmentRow, [string, number]>(
        "SELECT user_id, email FROM enrollments WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
      )
      .get(hash, now);
    if (!row) return null;
    const userId = userForEnrollment(db, row, profile);
    if (userId === null) return null;
    db.query("UPDATE enrollments SET used_at = ? WHERE code_hash = ?").run(now, hash);
    return userId;
  })();
}
