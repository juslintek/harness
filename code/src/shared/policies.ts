import { z } from "zod";

export const layers = ["harness", "org", "team", "agent", "task"] as const;
export type Layer = (typeof layers)[number];

export interface PolicyValues {
  autonomy: "full" | "supervised" | "strict";
  "hiring.decision": "auto" | "manager" | "human";
  "hiring.autoMinScore": number;
  "router.allowedRuntimes": string[] | null;
  "router.failover": boolean;
  "heartbeat.maxRunsPerHour": number;
}
export type PolicyKey = keyof PolicyValues;
export type PolicyValue<K extends PolicyKey> = PolicyValues[K];

interface PolicyDef<T> {
  schema: z.ZodType<T>;
  default: T;
  // Ordered loose to strict; a lower layer may never sit before its parent in this order.
  tightenOnly?: readonly T[];
}

export const policyKeys: { [K in PolicyKey]: PolicyDef<PolicyValues[K]> } = {
  autonomy: {
    schema: z.enum(["full", "supervised", "strict"]),
    default: "full",
    tightenOnly: ["full", "supervised", "strict"],
  },
  "hiring.decision": { schema: z.enum(["auto", "manager", "human"]), default: "manager" },
  "hiring.autoMinScore": { schema: z.number().min(0).max(5), default: 3.5 },
  "router.allowedRuntimes": { schema: z.array(z.string().min(1)).nullable(), default: null },
  "router.failover": { schema: z.boolean(), default: true },
  "heartbeat.maxRunsPerHour": { schema: z.number().int().min(1).max(200), default: 20 },
};

export const policyKeyNames: readonly PolicyKey[] = Object.keys(policyKeys) as PolicyKey[];

const keyName = z.enum(policyKeyNames as [PolicyKey, ...PolicyKey[]]);
const writableLayer = z.enum(["org", "team", "agent", "task"]);

type WritableLayer = "org" | "team" | "agent" | "task";
type Status = "open" | "approved" | "rejected" | "withdrawn";

export interface PolicyWriteBody {
  layer: WritableLayer;
  targetId: string;
  key: PolicyKey;
  value?: unknown;
}
export const policyWriteBody: z.ZodType<PolicyWriteBody> = z.strictObject({
  layer: writableLayer,
  targetId: z.string().min(1),
  key: keyName,
  value: z.unknown(),
});

export interface PolicyClearQuery {
  layer: WritableLayer;
  targetId: string;
  key: PolicyKey;
}
export const policyClearQuery: z.ZodType<PolicyClearQuery> = z.strictObject({
  layer: writableLayer,
  targetId: z.string().min(1),
  key: keyName,
});

export interface HarnessPolicyBody {
  key: PolicyKey;
  value?: unknown;
}
export const harnessPolicyBody: z.ZodType<HarnessPolicyBody> = z.strictObject({
  key: keyName,
  value: z.unknown(),
});

export interface PolicyDecideBody {
  decision: "approve" | "reject";
  reason: string;
}
export const policyDecideBody: z.ZodType<PolicyDecideBody> = z.strictObject({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().max(2000).default(""),
});

export interface ProposalListQuery {
  status?: Status | undefined;
}
export const proposalListQuery: z.ZodType<ProposalListQuery> = z.strictObject({
  status: z.enum(["open", "approved", "rejected", "withdrawn"]).optional(),
});

export interface PolicyExplainQuery {
  team?: string | undefined;
  member?: string | undefined;
  task?: string | undefined;
}
export const policyExplainQuery: z.ZodType<PolicyExplainQuery> = z.strictObject({
  team: z.string().min(1).optional(),
  member: z.string().min(1).optional(),
  task: z.string().min(1).optional(),
});
