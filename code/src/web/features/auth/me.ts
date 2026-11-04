import { type Signal, signal } from "@preact/signals";
import { z } from "zod";
import { api } from "../../api";
import { takeReturn } from "../../route";

export interface Me {
  user: { id: string; email: string; name: string; instanceAdmin: boolean };
  orgs: { id: string; slug: string; name: string; role: string }[];
}

const meSchema: z.ZodType<Me> = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    instanceAdmin: z.boolean(),
  }),
  orgs: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string(), role: z.string() })),
});

// Mirrors the server's approval scope: the instance admin, or an owner or admin of any org.
export const canDecideApprovals = (m: Me | null): boolean =>
  m !== null &&
  (m.user.instanceAdmin || m.orgs.some((o) => o.role === "owner" || o.role === "admin"));

// Viewers get 403 from the org logs endpoint, so the UI hides what they cannot use.
export const isViewerIn = (m: Me | null, slug: string): boolean =>
  m?.orgs.find((o) => o.slug === slug)?.role === "viewer";

export const ignored: z.ZodType<unknown> = z.unknown();

export const me: Signal<Me | null> = signal<Me | null>(null);

export async function refreshMe(): Promise<void> {
  me.value = await api("/api/auth/me", meSchema);
}

export async function leaveLogin(): Promise<void> {
  await refreshMe();
  location.hash = takeReturn();
}
