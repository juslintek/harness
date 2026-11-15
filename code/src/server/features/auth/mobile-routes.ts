import type { Database } from "bun:sqlite";
import type { Context, Hono } from "hono";
import {
  mobileEnrollOptionsBody,
  mobileEnrollVerifyBody,
  mobilePairOptionsBody,
  mobilePairVerifyBody,
} from "../../../shared/auth";
import { ensurePersonalOrg } from "../orgs/api";
import {
  claimEnrollment,
  completeEnrollment,
  enrollmentUser,
  getUser,
  newRecoveryCodes,
  redeemEnrollment,
} from "./api";
import {
  createChallengeNonce,
  createMobileBearerToken,
  enrollPayload,
  pairPayload,
  verifyP256Signature,
} from "./mobile-crypto";
import {
  consumeChallenge,
  consumePairCode,
  createMobileSession,
  getLiveChallenge,
  getLivePairCode,
  insertMobileChallenge,
  insertMobileDevice,
} from "./mobile-devices";
import type { Rp } from "./passkeys";
import { invalidBody, parseBody } from "./routes-common";

interface MobileDeps {
  db: Database;
  rp: Rp;
}

const FIVE_MIN_MS = 5 * 60 * 1000;

function enrollOptionsHandler(deps: MobileDeps) {
  return async function handleEnrollOptions(c: Context): Promise<Response> {
    const body = await parseBody(c, mobileEnrollOptionsBody);
    if (!body) return invalidBody(c);
    const code = c.req.param("code") ?? "";
    const userId = redeemEnrollment(deps.db, code, {
      email: body.email ?? "",
      name: body.name ?? "",
    });
    if (!userId) return c.json({ error: "enrollment code is not valid" }, 400);
    const nonce = createChallengeNonce();
    const { id: challengeId } = insertMobileChallenge(deps.db, {
      purpose: "enroll",
      nonce,
      userId,
      ttlMs: FIVE_MIN_MS,
    });
    return c.json({ challengeId, nonce, userId, rpOrigin: deps.rp.origin });
  };
}

function enrollVerifyHandler(deps: MobileDeps) {
  return async function handleEnrollVerify(c: Context): Promise<Response> {
    const body = await parseBody(c, mobileEnrollVerifyBody);
    if (!body) return invalidBody(c);
    const code = c.req.param("code") ?? "";
    if (enrollmentUser(deps.db, code) !== body.userId) {
      return c.json({ error: "enrollment code is not valid" }, 400);
    }
    const challenge = getLiveChallenge(deps.db, body.challengeId, "enroll");
    if (!challenge || challenge.user_id !== body.userId) {
      return c.json({ error: "invalid_challenge" }, 400);
    }
    const payload = enrollPayload(deps.rp.origin, body.challengeId, challenge.nonce);
    const valid = await verifyP256Signature(body.publicKeySpki, body.signature, payload);
    if (!valid) return c.json({ error: "invalid_signature" }, 400);
    const agent = c.req.header("user-agent")?.slice(0, 200) ?? null;
    const res = deps.db.transaction(() => {
      if (!claimEnrollment(deps.db, code)) {
        return { status: 409 as const, error: "enrollment already in progress" };
      }
      if (!consumeChallenge(deps.db, challenge.id, "enroll")) {
        return { status: 400 as const, error: "invalid_challenge" };
      }
      completeEnrollment(deps.db, code);

      const token = createMobileBearerToken();
      const { id: sessionId } = createMobileSession(deps.db, body.userId, token, agent);
      const deviceId = insertMobileDevice(deps.db, {
        userId: body.userId,
        sessionId,
        name: body.deviceName,
        platform: body.platform,
        publicKeySpki: body.publicKeySpki,
      });
      const user = getUser(deps.db, body.userId);
      if (!user) return { status: 401 as const, error: "unauthorized" };
      ensurePersonalOrg(deps.db, user);
      const recoveryCodes = newRecoveryCodes(deps.db, body.userId);
      return { status: 200 as const, data: { token, deviceId, user, recoveryCodes } };
    })();

    if (res.status !== 200) return c.json({ error: res.error }, res.status);
    return c.json(res.data);
  };
}

function pairOptionsHandler(deps: MobileDeps) {
  return async function handlePairOptions(c: Context): Promise<Response> {
    const body = await parseBody(c, mobilePairOptionsBody);
    if (!body) return invalidBody(c);
    const pairCode = getLivePairCode(deps.db, body.code);
    if (!pairCode) return c.json({ error: "invalid_code" }, 400);
    const nonce = createChallengeNonce();
    const { id: challengeId } = insertMobileChallenge(deps.db, {
      purpose: "pair",
      nonce,
      userId: pairCode.userId,
      codeHash: pairCode.codeHash,
      ttlMs: FIVE_MIN_MS,
    });
    return c.json({ challengeId, nonce, rpOrigin: deps.rp.origin });
  };
}

function pairVerifyTransaction(
  deps: MobileDeps,
  codeHash: string,
  challengeId: string,
  userId: string,
  deviceName: string,
  platform: "ios" | "android",
  publicKeySpki: string,
  agent: string | null,
): { token: string; deviceId: string } {
  let token = "";
  let deviceId = "";
  deps.db.transaction(() => {
    if (!consumePairCode(deps.db, codeHash)) throw new Error("invalid_code");
    if (!consumeChallenge(deps.db, challengeId, "pair")) throw new Error("invalid_challenge");
    token = createMobileBearerToken();
    const { id: sessionId } = createMobileSession(deps.db, userId, token, agent);
    deviceId = insertMobileDevice(deps.db, {
      userId,
      sessionId,
      name: deviceName,
      platform,
      publicKeySpki,
    });
    const user = getUser(deps.db, userId);
    if (user) ensurePersonalOrg(deps.db, user);
  })();
  return { token, deviceId };
}

function validatePairChallenge(deps: MobileDeps, code: string, challengeId: string) {
  const pairCode = getLivePairCode(deps.db, code);
  if (!pairCode) return { error: "invalid_code" as const };
  const challenge = getLiveChallenge(deps.db, challengeId, "pair");
  if (!challenge || challenge.code_hash !== pairCode.codeHash) {
    return { error: "invalid_challenge" as const };
  }
  return { pairCode, challenge };
}

function runPairTransaction(
  deps: MobileDeps,
  codeHash: string,
  challengeId: string,
  userId: string,
  deviceName: string,
  platform: "ios" | "android",
  publicKeySpki: string,
  agent: string | null,
): { token: string; deviceId: string } | { error: "invalid_challenge" | "invalid_code" } {
  try {
    return pairVerifyTransaction(
      deps,
      codeHash,
      challengeId,
      userId,
      deviceName,
      platform,
      publicKeySpki,
      agent,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "";
    return { error: msg === "invalid_challenge" ? "invalid_challenge" : "invalid_code" };
  }
}

function pairVerifyHandler(deps: MobileDeps) {
  return async function handlePairVerify(c: Context): Promise<Response> {
    const body = await parseBody(c, mobilePairVerifyBody);
    if (!body) return invalidBody(c);

    const checked = validatePairChallenge(deps, body.code, body.challengeId);
    if ("error" in checked) return c.json({ error: checked.error }, 400);

    const payload = pairPayload(deps.rp.origin, body.challengeId, checked.challenge.nonce);
    const valid = await verifyP256Signature(body.publicKeySpki, body.signature, payload);
    if (!valid) return c.json({ error: "invalid_signature" }, 400);

    const agent = c.req.header("user-agent")?.slice(0, 200) ?? null;
    const res = runPairTransaction(
      deps,
      checked.pairCode.codeHash,
      checked.challenge.id,
      checked.pairCode.userId,
      body.deviceName,
      body.platform,
      body.publicKeySpki,
      agent,
    );
    if ("error" in res) return c.json({ error: res.error }, 400);
    const user = getUser(deps.db, checked.pairCode.userId);
    return user
      ? c.json({ token: res.token, deviceId: res.deviceId, user })
      : c.json({ error: "unauthorized" }, 401);
  };
}

export function mobilePublicRoutes(app: Hono, deps: MobileDeps): void {
  app.post("/mobile/enroll/:code/options", enrollOptionsHandler(deps));
  app.post("/mobile/enroll/:code/verify", enrollVerifyHandler(deps));
  app.post("/mobile/pair/options", pairOptionsHandler(deps));
  app.post("/mobile/pair/verify", pairVerifyHandler(deps));
}
