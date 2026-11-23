import { orgDetailSchema } from "@shared/orgs";
import { z } from "zod";
import { api } from "../../api";
import { me } from "../../auth/me";

export interface Identity {
  instanceId: string;
  name: string;
  fingerprint: string;
}

export interface Peer {
  id: string;
  name: string;
  url: string;
  fingerprint: string;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

export interface Share {
  projectId: string;
  projectName: string;
  peerId: string;
  peerName: string | null;
  permission: "read" | "write";
}

export interface Invite {
  token: string;
  expiresAt: number;
}

export interface ProjectChoice {
  id: string;
  label: string;
}

export const identitySchema: z.ZodType<Identity> = z.object({
  instanceId: z.string(),
  name: z.string(),
  fingerprint: z.string(),
});

export const peersSchema: z.ZodType<Peer[]> = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    fingerprint: z.string(),
    lastSeenAt: z.number().nullable(),
    revokedAt: z.number().nullable(),
  }),
);

export const sharesSchema: z.ZodType<Share[]> = z.array(
  z.object({
    projectId: z.string(),
    projectName: z.string(),
    peerId: z.string(),
    peerName: z.string().nullable(),
    permission: z.enum(["read", "write"]),
  }),
);

export const inviteSchema: z.ZodType<Invite> = z.object({
  token: z.string(),
  expiresAt: z.number(),
});

export const pairedSchema: z.ZodType<{ id: string; name: string }> = z.object({
  id: z.string(),
  name: z.string(),
});

export async function loadShareableProjects(): Promise<ProjectChoice[]> {
  const orgs = me()?.orgs ?? [];
  const details = await Promise.all(orgs.map((o) => api(`/api/orgs/${o.slug}`, orgDetailSchema)));
  return details.flatMap((d) =>
    d.projects
      .filter((p) => p.orgId === d.org.id)
      .map((p) => ({ id: p.id, label: `${d.org.slug}/${p.key} ${p.name}` })),
  );
}
