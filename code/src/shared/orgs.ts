import { z } from "zod";

const pattern = /^[a-z0-9][a-z0-9_-]{1,31}$/;

export const handleSchema: z.ZodString = z
  .string()
  .regex(pattern, "lowercase letters, digits, _ and -, 2 to 32 chars");

const roleSchema: z.ZodEnum<{
  owner: "owner";
  admin: "admin";
  member: "member";
  viewer: "viewer";
}> = z.enum(["owner", "admin", "member", "viewer"]);

export type Role = z.infer<typeof roleSchema>;

export interface OrgView {
  id: string;
  slug: string;
  name: string;
  createdAt: number;
}
