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

const title = z.string().trim().min(1).max(80);
const id = z.string().min(1).max(64);

export interface CreateOrgBody {
  name: string;
  slug: string;
}
export const createOrgBody: z.ZodType<CreateOrgBody> = z
  .object({ name: title, slug: handleSchema })
  .strict();

export interface NameBody {
  name: string;
}
export const nameBody: z.ZodType<NameBody> = z.object({ name: title }).strict();

export interface MemberIdBody {
  memberId: string;
}
export const memberIdBody: z.ZodType<MemberIdBody> = z.object({ memberId: id }).strict();

export interface AddHumanBody {
  email: string;
  role: Role;
  name?: string | undefined;
  handle?: string | undefined;
}
export const addHumanBody: z.ZodType<AddHumanBody> = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
    role: roleSchema,
    name: title.optional(),
    handle: handleSchema.optional(),
  })
  .strict();

export interface AddAgentBody {
  agentId: string;
  handle: string;
  displayName: string;
  model?: string | undefined;
  specialties?: string[] | undefined;
  heartbeatMinutes?: number | undefined;
}
export const addAgentBody: z.ZodType<AddAgentBody> = z
  .object({
    agentId: id,
    handle: handleSchema,
    displayName: title,
    model: z.string().min(1).max(120).optional(),
    specialties: z.array(z.string().min(1).max(40)).max(20).optional(),
    heartbeatMinutes: z.number().int().min(1).max(10080).optional(),
  })
  .strict();

export interface MemberPatchBody {
  displayName?: string | undefined;
  role?: Role | undefined;
  model?: string | null | undefined;
  specialties?: string[] | undefined;
  heartbeatMinutes?: number | null | undefined;
  paused?: boolean | undefined;
}
export const memberPatchBody: z.ZodType<MemberPatchBody> = z
  .object({
    displayName: title.optional(),
    role: roleSchema.optional(),
    model: z.string().min(1).max(120).nullable().optional(),
    specialties: z.array(z.string().min(1).max(40)).max(20).optional(),
    heartbeatMinutes: z.number().int().min(1).max(10080).nullable().optional(),
    paused: z.boolean().optional(),
  })
  .strict();

export interface PositionBody {
  title: string;
  teamId?: string | undefined;
  memberId?: string | undefined;
  reportsTo?: string | undefined;
  isManager?: boolean | undefined;
}
export const positionBody: z.ZodType<PositionBody> = z
  .object({
    title,
    teamId: id.optional(),
    memberId: id.optional(),
    reportsTo: id.optional(),
    isManager: z.boolean().optional(),
  })
  .strict();

export interface PositionPatchBody {
  title?: string | undefined;
  teamId?: string | null | undefined;
  memberId?: string | null | undefined;
  reportsTo?: string | null | undefined;
  isManager?: boolean | undefined;
}
export const positionPatchBody: z.ZodType<PositionPatchBody> = z
  .object({
    title: title.optional(),
    teamId: id.nullable().optional(),
    memberId: id.nullable().optional(),
    reportsTo: id.nullable().optional(),
    isManager: z.boolean().optional(),
  })
  .strict();

export interface ProjectBody {
  key: string;
  name: string;
  teamId?: string | undefined;
  repo?: string | undefined;
}
export const projectBody: z.ZodType<ProjectBody> = z
  .object({
    key: z
      .string()
      .min(1)
      .max(16)
      .regex(/^[A-Za-z0-9_-]+$/),
    name: title,
    teamId: id.optional(),
    repo: z.string().min(1).max(1024).optional(),
  })
  .strict();

export interface GrantBody {
  orgId: string;
  permission: "read" | "write";
}
export const grantBody: z.ZodType<GrantBody> = z
  .object({ orgId: id, permission: z.enum(["read", "write"]) })
  .strict();

export interface RevokeBody {
  orgId: string;
}
export const revokeBody: z.ZodType<RevokeBody> = z.object({ orgId: id }).strict();
