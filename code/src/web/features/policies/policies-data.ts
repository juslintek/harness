import { z } from "zod";
import { type Layer, layers, type PolicyKey, policyKeyNames } from "../../../shared/policies";

const keyName = z.enum(policyKeyNames as [PolicyKey, ...PolicyKey[]]);

export type ScopeLayer = Exclude<Layer, "harness">;

export interface EffectivePolicy {
  key: PolicyKey;
  value?: unknown;
  layer: Layer | "default";
  targetId: string | null;
  setBy: string | null;
  chain: { layer: Layer; targetId: string; value?: unknown }[];
}

export const effectiveListSchema: z.ZodType<EffectivePolicy[]> = z.array(
  z.object({
    key: keyName,
    value: z.unknown(),
    layer: z.enum([...layers, "default"]),
    targetId: z.string().nullable(),
    setBy: z.string().nullable(),
    chain: z.array(z.object({ layer: z.enum(layers), targetId: z.string(), value: z.unknown() })),
  }),
);

export interface Proposal {
  id: string;
  targetId: string;
  key: PolicyKey;
  value?: unknown;
  reason: string;
  proposedBy: string;
  status: "open" | "approved" | "rejected" | "withdrawn";
  decisionReason: string | null;
  createdAt: number;
  reviews: { reviewerId: string; verdict: "approve" | "reject"; comment: string | null }[];
}

export const proposalListSchema: z.ZodType<Proposal[]> = z.array(
  z.object({
    id: z.string(),
    targetId: z.string(),
    key: keyName,
    value: z.unknown(),
    reason: z.string(),
    proposedBy: z.string(),
    status: z.enum(["open", "approved", "rejected", "withdrawn"]),
    decisionReason: z.string().nullable(),
    createdAt: z.number(),
    reviews: z.array(
      z.object({
        reviewerId: z.string(),
        verdict: z.enum(["approve", "reject"]),
        comment: z.string().nullable(),
      }),
    ),
  }),
);

export type Field = { kind: "choice"; options: string[] } | { kind: "number" } | { kind: "list" };

export const fields: Record<PolicyKey, Field> = {
  autonomy: { kind: "choice", options: ["full", "supervised", "strict"] },
  "hiring.decision": { kind: "choice", options: ["auto", "manager", "human"] },
  "hiring.autoMinScore": { kind: "number" },
  "router.allowedRuntimes": { kind: "list" },
  "router.failover": { kind: "choice", options: ["true", "false"] },
  "heartbeat.maxRunsPerHour": { kind: "number" },
};

export function show(value: unknown): string {
  if (value === null || value === undefined) return "no restriction";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

// The text a form control holds for a value; a null list is an empty box.
export const toText = (value: unknown): string =>
  value === null || value === undefined ? "" : show(value);

export function parseValue(key: PolicyKey, text: string): unknown {
  const field = fields[key];
  if (field.kind === "number") return Number(text);
  if (field.kind === "list") {
    const names = text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return names.length === 0 ? null : names;
  }
  return key === "router.failover" ? text === "true" : text;
}

export const handleOf = (id: string, members: { id: string; handle: string }[]): string =>
  members.find((m) => m.id === id)?.handle ?? id;
