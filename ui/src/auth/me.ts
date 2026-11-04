import { createSignal } from "solid-js";
import { z } from "zod";
import { api } from "../api";

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

export const ignored: z.ZodType<unknown> = z.unknown();

export const [me, setMe] = createSignal<Me | null>(null);

export async function refreshMe(): Promise<void> {
  setMe(await api("/api/auth/me", meSchema));
}

// Only navigates: the app loads the account for any route but login and enroll, so a failed load
// shows its own retry instead of leaving a used code on the form.
export async function leaveLogin(): Promise<void> {
  location.hash = "#/";
}
