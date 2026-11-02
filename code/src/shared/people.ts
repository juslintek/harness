import { z } from "zod";

// Who a task or message belongs to, resolved server side because the viewer may sit in a different
// org than the member (a grantee reading a granted project).
export interface PersonRef {
  handle: string;
  displayName: string;
  kind: "human" | "agent";
}
export const personRefSchema: z.ZodType<PersonRef> = z.object({
  handle: z.string(),
  displayName: z.string(),
  kind: z.enum(["human", "agent"]),
});
