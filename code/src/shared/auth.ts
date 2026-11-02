import { z } from "zod";

const b64 = z.string().min(1).max(16384);
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const code = z.string().trim().min(1).max(64);
const label = z.string().trim().min(1).max(80);

const credential = {
  id: b64,
  rawId: b64,
  type: z.literal("public-key"),
  clientExtensionResults: z.record(z.string(), z.unknown()),
};

interface Assertion {
  id: string;
  rawId: string;
  type: "public-key";
  clientExtensionResults: Record<string, unknown>;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string | undefined;
  };
}
const assertion: z.ZodType<Assertion> = z.object({
  ...credential,
  response: z.object({
    clientDataJSON: b64,
    authenticatorData: b64,
    signature: b64,
    userHandle: b64.optional(),
  }),
});

interface Attestation {
  id: string;
  rawId: string;
  type: "public-key";
  clientExtensionResults: Record<string, unknown>;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[] | undefined;
  };
}
const attestation: z.ZodType<Attestation> = z.object({
  ...credential,
  response: z.object({
    clientDataJSON: b64,
    attestationObject: b64,
    transports: z.array(z.string().max(32)).max(8).optional(),
  }),
});

interface AssertionBody {
  challengeId: string;
  response: Assertion;
}
export const assertionBody: z.ZodType<AssertionBody> = z.object({
  challengeId: z.string().min(1).max(64),
  response: assertion,
});

export interface PasskeyBody {
  challengeId: string;
  response: Attestation;
  name: string;
}
export const passkeyBody: z.ZodType<PasskeyBody> = z.object({
  challengeId: z.string().min(1).max(64),
  response: attestation,
  name: label.default("Passkey"),
});

export interface EmailBody {
  email: string;
}
export const emailBody: z.ZodType<EmailBody> = z.object({ email });

export interface CodeBody {
  email: string;
  code: string;
}
export const codeBody: z.ZodType<CodeBody> = z.object({ email, code });

export interface EnrollOptionsBody {
  email: string;
  name: string;
}
export const enrollOptionsBody: z.ZodType<EnrollOptionsBody> = z.object({ email, name: label });

export interface EnrollVerifyBody extends PasskeyBody {
  userId: string;
}
export const enrollVerifyBody: z.ZodType<EnrollVerifyBody> = z.object({
  challengeId: z.string().min(1).max(64),
  userId: z.string().min(1).max(64),
  response: attestation,
  name: label.default("Passkey"),
});
