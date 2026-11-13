import { type PolicyProposal, policyKeyNames } from "@shared/policies";
import { z } from "zod";

export type Proposal = PolicyProposal & { decidedBy: string | null; decidedAt: number | null };

const keyName = z.enum(policyKeyNames as [string, ...string[]]);

// The server also returns who decided and when; the shared schema drops both, so the list is
// parsed here with the two extra fields.
export const proposalsSchema = z.array(
  z.object({
    id: z.string(),
    targetId: z.string(),
    key: keyName,
    value: z.unknown(),
    reason: z.string(),
    proposedBy: z.string(),
    status: z.enum(["open", "approved", "rejected", "withdrawn"]),
    decidedBy: z.string().nullable(),
    decisionReason: z.string().nullable(),
    createdAt: z.number(),
    decidedAt: z.number().nullable(),
    reviews: z.array(
      z.object({
        reviewerId: z.string(),
        verdict: z.enum(["approve", "reject"]),
        comment: z.string().nullable(),
      }),
    ),
  }),
) as unknown as z.ZodType<Proposal[]>;
