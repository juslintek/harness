import { sign, verify } from "node:crypto";
import { instanceKeys, parsePublicKey } from "./keys";

// Proof that a pairing party holds the private key behind the public key it presents. The text
// covers the invite token (one-time, so a proof cannot be replayed to another pairing), the
// instance ids (the dialing side does not know the other id yet, so it passes an empty one) and
// the signer's own url, so a relay cannot swap the address a peer will be stored under. The fields
// go in as a JSON array under a fixed domain tag: a bare separator would let a value that contains
// it move bytes into the next field and make one signature cover two different answers. The
// direction is part of it so a request proof can never pass as an answer.
type Direction = "request" | "answer";

const text = (
  direction: Direction,
  token: string,
  signer: string,
  other: string,
  url: string,
): Buffer => Buffer.from(JSON.stringify(["harness-pair/v2", direction, token, signer, other, url]));

export function pairProof(
  home: string,
  direction: Direction,
  token: string,
  signer: string,
  other: string,
  url: string,
): string {
  return sign(
    null,
    text(direction, token, signer, other, url),
    instanceKeys(home).privateKey,
  ).toString("base64url");
}

export function pairProofHolds(
  publicKey: string,
  proof: string,
  direction: Direction,
  token: string,
  signer: string,
  other: string,
  url: string,
): boolean {
  try {
    return verify(
      null,
      text(direction, token, signer, other, url),
      parsePublicKey(publicKey),
      Buffer.from(proof, "base64url"),
    );
  } catch {
    return false;
  }
}
