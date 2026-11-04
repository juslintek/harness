import { z } from "zod";

export interface GrantView {
  id: string;
  clientName: string;
  orgId: string;
  orgName: string;
  scopes: string[];
  createdAt: number;
}

export const grantViewSchema: z.ZodType<GrantView> = z.object({
  id: z.string(),
  clientName: z.string(),
  orgId: z.string(),
  orgName: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.number(),
});

export interface ConsentResult {
  redirect: string;
}

export const consentResultSchema: z.ZodType<ConsentResult> = z.object({ redirect: z.string() });

export const clientInfoSchema: z.ZodType<{ name: string }> = z.object({ name: z.string() });
