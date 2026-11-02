import type { Database } from "bun:sqlite";
import { randomInt } from "node:crypto";
import { safeEqual } from "./admin";
import { sha256Hex } from "./sessions";
import { createUser, findUserByEmail } from "./users";

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
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  // Count and insert share one transaction so concurrent requests cannot both pass the limit.
  const allowed = db.transaction((): boolean => {
    db.query("DELETE FROM email_codes WHERE created_at < ?").run(now - EMAIL_WINDOW_MS);
    const recent = db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM email_codes WHERE email = ?")
      .get(email)?.n;
    if ((recent ?? 0) >= EMAIL_MAX_PER_WINDOW) return false;
    db.query("UPDATE email_codes SET used_at = ? WHERE email = ? AND used_at IS NULL").run(
      now,
      email,
    );
    db.query(
      "INSERT INTO email_codes (id, email, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).run(Bun.randomUUIDv7(), email, sha256Hex(code), now, now + EMAIL_CODE_TTL_MS);
    return true;
  })();
  if (!allowed) return "rate_limited";
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
  redeemed_user_id: string | null;
}

function userForEnrollment(
  db: Database,
  row: EnrollmentRow,
  profile: { email: string; name: string },
): string | null {
  if (row.user_id) return row.user_id;
  const bootstrap = row.email === null;
  if (bootstrap && db.query("SELECT 1 FROM users WHERE instance_admin = 1").get()) return null;
  if (row.email !== null && row.email.toLowerCase() !== profile.email.toLowerCase()) return null;
  if (findUserByEmail(db, profile.email)) return null;
  return createUser(db, { ...profile, instanceAdmin: bootstrap });
}

const LIVE_ENROLLMENT =
  "SELECT user_id, email, redeemed_user_id FROM enrollments WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?";

// Redeeming only fixes which user the code is for; the code stays live until completeEnrollment,
// so a cancelled passkey prompt can ask again and get a fresh challenge for the same user.
export function redeemEnrollment(
  db: Database,
  code: string,
  profile: { email: string; name: string },
): string | null {
  return db.transaction((): string | null => {
    const hash = sha256Hex(normalizeCode(code));
    const row = db.query<EnrollmentRow, [string, number]>(LIVE_ENROLLMENT).get(hash, Date.now());
    if (!row) return null;
    if (row.redeemed_user_id) return row.redeemed_user_id;
    const userId = userForEnrollment(db, row, profile);
    if (userId === null) return null;
    db.query("UPDATE enrollments SET redeemed_user_id = ? WHERE code_hash = ?").run(userId, hash);
    return userId;
  })();
}

export function enrollmentUser(db: Database, code: string): string | null {
  const hash = sha256Hex(normalizeCode(code));
  return (
    db.query<EnrollmentRow, [string, number]>(LIVE_ENROLLMENT).get(hash, Date.now())
      ?.redeemed_user_id ?? null
  );
}

const CLAIM_TTL_MS = 60_000;

// Two concurrent verifies for one code would both pass the live check while the first is still
// awaiting the passkey check; only one wins the claim. A claim left by a crashed request expires.
export function claimEnrollment(db: Database, code: string): boolean {
  const now = Date.now();
  return (
    db
      .query(
        `UPDATE enrollments SET claimed_at = ?
          WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
            AND (claimed_at IS NULL OR claimed_at < ?)`,
      )
      .run(now, sha256Hex(normalizeCode(code)), now, now - CLAIM_TTL_MS).changes > 0
  );
}

export function releaseEnrollment(db: Database, code: string): void {
  db.query("UPDATE enrollments SET claimed_at = NULL WHERE code_hash = ? AND used_at IS NULL").run(
    sha256Hex(normalizeCode(code)),
  );
}

export function completeEnrollment(db: Database, code: string): void {
  db.query("UPDATE enrollments SET used_at = ? WHERE code_hash = ? AND used_at IS NULL").run(
    Date.now(),
    sha256Hex(normalizeCode(code)),
  );
}

// First run is an instance with no admin who holds a passkey. A regular user with a passkey does
// not count, and is never promoted: with no admin at all the link creates a new admin user. An
// admin who has no passkey yet gets the link for their own account. Older unused bootstrap links
// die first so only one first-run link is ever live.
export function firstRunEnrollment(db: Database, ttlMs: number): string | null {
  const enrolled = db
    .query(
      `SELECT 1 FROM users u WHERE u.instance_admin = 1
         AND EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id)`,
    )
    .get();
  if (enrolled) return null;
  const admin = db
    .query<{ id: string }, []>(
      "SELECT id FROM users WHERE instance_admin = 1 ORDER BY created_at, id LIMIT 1",
    )
    .get();
  db.query(
    `UPDATE enrollments SET used_at = ?
      WHERE used_at IS NULL AND ((user_id IS NULL AND email IS NULL) OR user_id = ?)`,
  ).run(Date.now(), admin?.id ?? null);
  return createEnrollment(db, admin ? { userId: admin.id, ttlMs } : { ttlMs });
}
