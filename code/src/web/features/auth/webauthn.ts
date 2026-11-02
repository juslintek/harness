import { z } from "zod";

export type CreationChallenge = PublicKeyCredentialCreationOptionsJSON & { challengeId: string };
export type RequestChallenge = PublicKeyCredentialRequestOptionsJSON & { challengeId: string };

const hasChallenge = (v: unknown): boolean =>
  typeof v === "object" &&
  v !== null &&
  "challengeId" in v &&
  typeof v.challengeId === "string" &&
  "challenge" in v;

// The server builds these with simplewebauthn, so only the shape the browser helpers rely on is checked.
export const creationChallengeSchema: z.ZodType<CreationChallenge> = z.custom<CreationChallenge>(
  hasChallenge,
  "unexpected passkey options",
);
export const requestChallengeSchema: z.ZodType<RequestChallenge> = z.custom<RequestChallenge>(
  hasChallenge,
  "unexpected passkey options",
);

function assertSupported(): void {
  if (
    typeof PublicKeyCredential === "undefined" ||
    typeof PublicKeyCredential.parseCreationOptionsFromJSON !== "function" ||
    typeof PublicKeyCredential.parseRequestOptionsFromJSON !== "function"
  ) {
    throw new Error("This browser cannot use passkeys here. Update it or use an email code.");
  }
}

function asJson(credential: Credential | null): unknown {
  if (!(credential instanceof PublicKeyCredential)) throw new Error("No passkey was returned.");
  return credential.toJSON();
}

export async function register(options: CreationChallenge): Promise<unknown> {
  assertSupported();
  const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(options);
  return asJson(await navigator.credentials.create({ publicKey }));
}

export async function authenticate(options: RequestChallenge): Promise<unknown> {
  assertSupported();
  const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(options);
  return asJson(await navigator.credentials.get({ publicKey }));
}

// The caller passes its own POST so this file does not import the api module that calls it.
export async function stepUp(
  post: (path: string, body: unknown) => Promise<unknown>,
): Promise<void> {
  const options = requestChallengeSchema.parse(await post("/api/auth/step-up/options", {}));
  const response = await authenticate(options);
  await post("/api/auth/step-up/verify", { challengeId: options.challengeId, response });
}
