import { createDecipheriv, diffieHellman, generateKeyPairSync, randomBytes } from "node:crypto";
import { deriveKeys } from "../features/notify/push/encrypt";
import { publicKeyFromRaw, rawPublicKey } from "../features/notify/push/vapid";
import { startStub } from "./stub-server";

interface PushRequest {
  headers: Headers;
  body: Buffer;
}

export interface PushStub {
  url: string;
  requests: PushRequest[];
  status: number;
}

// Stands in for a push service; `status` can be changed between deliveries.
export async function startPushStub(status = 201): Promise<PushStub> {
  const requests: PushRequest[] = [];
  const stub: PushStub = { url: "", requests, status };
  const { url } = await startStub(async (req) => {
    requests.push({ headers: req.headers, body: Buffer.from(await req.arrayBuffer()) });
    return new Response(null, { status: stub.status });
  });
  stub.url = `${url}/push/abc`;
  return stub;
}

// A browser stand-in: the keys a subscription carries, and the matching decrypt.
export interface Receiver {
  p256dh: string;
  auth: string;
  decrypt(body: Buffer): string;
}

export function newReceiver(): Receiver {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const uaPublic = rawPublicKey(publicKey);
  const auth = randomBytes(16);
  return {
    p256dh: uaPublic.toString("base64url"),
    auth: auth.toString("base64url"),
    decrypt(body) {
      const idlen = body[20] ?? 0;
      const asPublic = body.subarray(21, 21 + idlen);
      const ecdh = diffieHellman({ privateKey, publicKey: publicKeyFromRaw(asPublic) });
      const { cek, nonce } = deriveKeys(ecdh, auth, uaPublic, asPublic, body.subarray(0, 16));
      const data = body.subarray(21 + idlen);
      const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
      decipher.setAuthTag(data.subarray(data.length - 16));
      const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
      return plain.subarray(0, plain.lastIndexOf(2)).toString();
    },
  };
}
