import { z } from "zod";

const ACCOUNT_KINDS = ["login", "api_key"] as const;
const ACCOUNT_STATES = [
  "unknown",
  "pending",
  "active",
  "logged_out",
  "probe_failed",
  "disabled",
  "removing",
  "removed",
] as const;

export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export type AccountState = (typeof ACCOUNT_STATES)[number];

const accountKind: z.ZodType<AccountKind> = z.enum(ACCOUNT_KINDS);
const accountState: z.ZodType<AccountState> = z.enum(ACCOUNT_STATES);

export interface AccountView {
  id: string;
  runtime: string;
  kind: AccountKind;
  label: string;
  home: string | null;
  state: AccountState;
  identityHint: string | null;
  maxConcurrent: number;
  priority: number;
  exhaustedUntil: number | null;
  lastProbeAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export const accountView: z.ZodType<AccountView> = z.object({
  id: z.string(),
  runtime: z.string(),
  kind: accountKind,
  label: z.string(),
  home: z.string().nullable(),
  state: accountState,
  identityHint: z.string().nullable(),
  maxConcurrent: z.number().int(),
  priority: z.number().int(),
  exhaustedUntil: z.number().int().nullable(),
  lastProbeAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
