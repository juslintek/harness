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

export interface MobileEnrollOptionsBody {
  email?: string | undefined;
  name?: string | undefined;
  deviceName: string;
  platform: "ios" | "android";
}
export const mobileEnrollOptionsBody: z.ZodType<MobileEnrollOptionsBody> = z.object({
  email: email.optional(),
  name: label.optional(),
  deviceName: label,
  platform: z.enum(["ios", "android"]),
});

export interface MobileEnrollVerifyBody {
  challengeId: string;
  userId: string;
  deviceName: string;
  platform: "ios" | "android";
  publicKeySpki: string;
  signature: string;
}
export const mobileEnrollVerifyBody: z.ZodType<MobileEnrollVerifyBody> = z.object({
  challengeId: z.string().min(1).max(64),
  userId: z.string().min(1).max(64),
  deviceName: label,
  platform: z.enum(["ios", "android"]),
  publicKeySpki: b64,
  signature: b64,
});

export interface MobilePairOptionsBody {
  code: string;
  deviceName: string;
  platform: "ios" | "android";
}
export const mobilePairOptionsBody: z.ZodType<MobilePairOptionsBody> = z.object({
  code,
  deviceName: label,
  platform: z.enum(["ios", "android"]),
});

export interface MobilePairVerifyBody {
  challengeId: string;
  code: string;
  deviceName: string;
  platform: "ios" | "android";
  publicKeySpki: string;
  signature: string;
}
export const mobilePairVerifyBody: z.ZodType<MobilePairVerifyBody> = z.object({
  challengeId: z.string().min(1).max(64),
  code,
  deviceName: label,
  platform: z.enum(["ios", "android"]),
  publicKeySpki: b64,
  signature: b64,
});

export interface MobileStepUpVerifyBody {
  challengeId: string;
  signature: string;
}
export const mobileStepUpVerifyBody: z.ZodType<MobileStepUpVerifyBody> = z.object({
  challengeId: z.string().min(1).max(64),
  signature: b64,
});

export interface MobileDeviceView {
  id: string;
  name: string;
  platform: "ios" | "android";
  createdAt: number;
  lastUsedAt: number;
  current: boolean;
}
export const mobileDeviceView: z.ZodType<MobileDeviceView> = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.enum(["ios", "android"]),
  createdAt: z.number(),
  lastUsedAt: z.number(),
  current: z.boolean(),
});

export interface MobilePairStartResult {
  code: string;
  expiresAt: number;
  uri: string;
}
export const mobilePairStartResult: z.ZodType<MobilePairStartResult> = z.object({
  code: z.string(),
  expiresAt: z.number(),
  uri: z.string(),
});
