import type { Database } from "bun:sqlite";
import type { Context, Hono } from "hono";
import { mobileDeviceView, mobileStepUpVerifyBody } from "../../../shared/auth";
import { type AuthEnv, hasFreshStepUp, requireStepUp, revokeSession, stepUpRequired } from "./api";
import { createChallengeNonce, stepUpPayload, verifyP256Signature } from "./mobile-crypto";
import {
  consumeChallenge,
  deleteMobileDevice,
  getLiveChallenge,
  getMobileDeviceById,
  getMobileDeviceForSession,
  insertMobileChallenge,
  insertPairCode,
  listMobileDevices,
  recordStepUp,
} from "./mobile-devices";
import type { Rp } from "./passkeys";
import { invalidBody, parseBody } from "./routes";

const FIVE_MIN_MS = 5 * 60 * 1000;
const TWO_MIN_MS = 2 * 60 * 1000;

function stepUpVerifyHandler(db: Database, rp: Rp) {
  return async function handleStepUpVerify(c: Context<AuthEnv>): Promise<Response> {
    const body = await parseBody(c, mobileStepUpVerifyBody);
    if (!body) return invalidBody(c);
    const actor = c.get("actor");
    const device = getMobileDeviceForSession(db, actor.id, actor.userId);
    if (!device) return c.json({ error: "not_mobile_session" }, 400);
    const challenge = getLiveChallenge(db, body.challengeId, "step_up");
    if (!challenge || challenge.device_id !== device.id || challenge.user_id !== actor.userId) {
      return c.json({ error: "invalid_challenge" }, 400);
    }
    const payload = stepUpPayload(rp.origin, actor.id, body.challengeId, challenge.nonce);
    const valid = await verifyP256Signature(device.publicKeySpki, body.signature, payload);
    if (!valid) return c.json({ error: "invalid_signature" }, 400);
    const stepUpAt = db.transaction((): number | null => {
      if (!consumeChallenge(db, challenge.id, "step_up")) return null;
      return recordStepUp(db, actor.id, device.id);
    })();
    if (stepUpAt === null) return c.json({ error: "invalid_challenge" }, 400);
    return c.json({ ok: true, stepUpAt });
  };
}

export function mobileAccountRoutes(app: Hono<AuthEnv>, db: Database, rp: Rp): void {
  app.post("/mobile/pair/start", requireStepUp, (c) => {
    const actor = c.get("actor");
    const code = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const expiresAt = insertPairCode(db, actor.userId, code, FIVE_MIN_MS);
    const uri = `harness://pair?origin=${encodeURIComponent(rp.origin)}&code=${encodeURIComponent(code)}`;
    return c.json({ code, expiresAt, uri }, 201);
  });

  app.post("/mobile/step-up/options", (c) => {
    const actor = c.get("actor");
    const device = getMobileDeviceForSession(db, actor.id, actor.userId);
    if (!device) return c.json({ error: "not_mobile_session" }, 400);
    const nonce = createChallengeNonce();
    const { id: challengeId, expiresAt } = insertMobileChallenge(db, {
      purpose: "step_up",
      nonce,
      userId: actor.userId,
      deviceId: device.id,
      ttlMs: TWO_MIN_MS,
    });
    return c.json({ challengeId, nonce, expiresAt });
  });

  app.post("/mobile/step-up/verify", stepUpVerifyHandler(db, rp));

  app.get("/mobile/devices", (c) => {
    const actor = c.get("actor");
    const devices = listMobileDevices(db, actor.userId).map((d) =>
      mobileDeviceView.parse({
        id: d.id,
        name: d.name,
        platform: d.platform,
        createdAt: d.createdAt,
        lastUsedAt: d.lastUsedAt,
        current: d.sessionId === actor.id,
      }),
    );
    return c.json(devices);
  });

  app.delete("/mobile/devices/:id", (c) => {
    const actor = c.get("actor");
    const deviceId = c.req.param("id");
    const device = getMobileDeviceById(db, deviceId, actor.userId);
    if (!device) return c.json({ error: "unknown device" }, 404);
    if (device.sessionId !== actor.id && !hasFreshStepUp(actor)) {
      return stepUpRequired(c);
    }
    revokeSession(db, actor.userId, device.sessionId);
    deleteMobileDevice(db, deviceId, actor.userId);
    return c.json({ ok: true });
  });
}
