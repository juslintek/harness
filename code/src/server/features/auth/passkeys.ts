import type { Database } from "bun:sqlite";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { getUser } from "./users";

export interface Rp {
  id: string;
  name: string;
  origin: string;
}

type Purpose = "register" | "login" | "step_up";
type Failure = { ok: false; reason: string };

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function storeChallenge(
  db: Database,
  challenge: string,
  purpose: Purpose,
  userId: string | null,
): string {
  const now = Date.now();
  const id = Bun.randomUUIDv7();
  db.query("DELETE FROM challenges WHERE expires_at < ?").run(now);
  db.query(
    "INSERT INTO challenges (id, challenge, purpose, user_id, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, challenge, purpose, userId, now + CHALLENGE_TTL_MS);
  return id;
}

// The row is deleted before it is checked, so a challenge is spent even by a failed attempt.
function consumeChallenge(
  db: Database,
  id: string,
  purpose: Purpose,
  userId: string | null,
): string | null {
  const row = db
    .query<
      { challenge: string; purpose: string; user_id: string | null; expires_at: number },
      [string]
    >("DELETE FROM challenges WHERE id = ? RETURNING challenge, purpose, user_id, expires_at")
    .get(id);
  if (!row || row.expires_at < Date.now()) return null;
  if (row.purpose !== purpose || row.user_id !== userId) return null;
  return row.challenge;
}

interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
}

function parseTransports(raw: string | null): string[] | undefined {
  return raw === null ? undefined : (JSON.parse(raw) as string[]);
}

function userPasskeys(db: Database, userId: string): { id: string; transports?: string[] }[] {
  return db
    .query<{ id: string; transports: string | null }, [string]>(
      "SELECT id, transports FROM passkeys WHERE user_id = ?",
    )
    .all(userId)
    .map((row) => {
      const transports = parseTransports(row.transports);
      return transports ? { id: row.id, transports } : { id: row.id };
    });
}

function reasonOf(error: unknown): Failure {
  return { ok: false, reason: error instanceof Error ? error.message : "verification failed" };
}

export async function registrationOptions(
  db: Database,
  rp: Rp,
  userId: string,
): Promise<PublicKeyCredentialCreationOptionsJSON & { challengeId: string }> {
  const user = getUser(db, userId);
  if (!user) throw new Error("unknown user");
  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userName: user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: userPasskeys(db, userId),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  return { ...options, challengeId: storeChallenge(db, options.challenge, "register", userId) };
}

export async function finishRegistration(
  db: Database,
  rp: Rp,
  userId: string,
  challengeId: string,
  response: RegistrationResponseJSON,
  name: string,
): Promise<{ ok: true; credentialId: string } | Failure> {
  const challenge = consumeChallenge(db, challengeId, "register", userId);
  if (challenge === null) return { ok: false, reason: "challenge expired or already used" };
  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: true,
    });
    if (!result.verified) return { ok: false, reason: "not verified" };
    const { credential } = result.registrationInfo;
    const exists = db.query("SELECT 1 FROM passkeys WHERE id = ?").get(credential.id);
    if (exists) return { ok: false, reason: "credential already registered" };
    db.query(
      `INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      credential.id,
      userId,
      credential.publicKey,
      credential.counter,
      credential.transports ? JSON.stringify(credential.transports) : null,
      name,
      Date.now(),
    );
    return { ok: true, credentialId: credential.id };
  } catch (error) {
    return reasonOf(error);
  }
}

export async function loginOptions(
  db: Database,
  rp: Rp,
): Promise<PublicKeyCredentialRequestOptionsJSON & { challengeId: string }> {
  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    userVerification: "preferred",
  });
  return { ...options, challengeId: storeChallenge(db, options.challenge, "login", null) };
}

export async function stepUpOptions(
  db: Database,
  rp: Rp,
  userId: string,
): Promise<PublicKeyCredentialRequestOptionsJSON & { challengeId: string }> {
  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    userVerification: "required",
    allowCredentials: userPasskeys(db, userId),
  });
  return { ...options, challengeId: storeChallenge(db, options.challenge, "step_up", userId) };
}

async function verifyAssertion(
  db: Database,
  rp: Rp,
  challengeId: string,
  purpose: Purpose,
  expectedUserId: string | null,
  response: AuthenticationResponseJSON,
): Promise<{ ok: true; userId: string } | Failure> {
  const requireUserVerification = purpose === "step_up";
  const challenge = consumeChallenge(db, challengeId, purpose, expectedUserId);
  if (challenge === null) return { ok: false, reason: "challenge expired or already used" };
  const row = db
    .query<PasskeyRow, [string]>(
      "SELECT id, user_id, public_key, counter, transports FROM passkeys WHERE id = ?",
    )
    .get(response.id);
  if (!row || (expectedUserId !== null && row.user_id !== expectedUserId)) {
    return { ok: false, reason: "unknown credential" };
  }
  try {
    const transports = parseTransports(row.transports);
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification,
      credential: {
        id: row.id,
        publicKey: new Uint8Array(row.public_key),
        counter: row.counter,
        ...(transports ? { transports } : {}),
      },
    });
    if (!result.verified) return { ok: false, reason: "not verified" };
    // max() so a slower parallel assertion cannot lower a counter another one already raised.
    db.query("UPDATE passkeys SET counter = max(counter, ?), last_used_at = ? WHERE id = ?").run(
      result.authenticationInfo.newCounter,
      Date.now(),
      row.id,
    );
    return { ok: true, userId: row.user_id };
  } catch (error) {
    return reasonOf(error);
  }
}

export function finishLogin(
  db: Database,
  rp: Rp,
  challengeId: string,
  response: AuthenticationResponseJSON,
): Promise<{ ok: true; userId: string } | Failure> {
  return verifyAssertion(db, rp, challengeId, "login", null, response);
}

export async function finishStepUp(
  db: Database,
  rp: Rp,
  sessionId: string,
  userId: string,
  challengeId: string,
  response: AuthenticationResponseJSON,
): Promise<{ ok: true } | Failure> {
  const result = await verifyAssertion(db, rp, challengeId, "step_up", userId, response);
  if (!result.ok) return result;
  const now = Date.now();
  const updated = db
    .query(
      `UPDATE sessions SET step_up_at = ?
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .run(now, sessionId, userId, now);
  return updated.changes === 1 ? { ok: true } : { ok: false, reason: "unknown session" };
}
