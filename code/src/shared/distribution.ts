import { z } from "zod";

export interface TargetView {
  id: string;
  kind: "ssh" | "tailscale" | "docker";
  name: string;
  address: string;
  user?: string | undefined;
  port?: number | undefined;
  note?: string | undefined;
}

export const targetViewSchema: z.ZodType<TargetView> = z.object({
  id: z.string(),
  kind: z.enum(["ssh", "tailscale", "docker"]),
  name: z.string(),
  address: z.string(),
  user: z.string().optional(),
  port: z.number().int().optional(),
  note: z.string().optional(),
});
