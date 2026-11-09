import { z } from "zod";

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
