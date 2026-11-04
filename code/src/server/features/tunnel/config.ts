import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const providerSchema: z.ZodEnum<{
  "tailscale-serve": "tailscale-serve";
  "tailscale-funnel": "tailscale-funnel";
  cloudflare: "cloudflare";
}> = z.enum(["tailscale-serve", "tailscale-funnel", "cloudflare"]);

export type Provider = z.infer<typeof providerSchema>;

// A quick tunnel only learns its origin when it starts, so a cloudflare entry may have none yet.
export interface TunnelConfig {
  provider: Provider;
  origin?: string | undefined;
}

const tunnelConfigSchema: z.ZodType<TunnelConfig> = z.object({
  provider: providerSchema,
  origin: z.string().optional(),
});

const tunnelFile = (home: string): string => join(home, "tunnel.json");

// Read at boot, before anything can serve a request: a damaged file must cost the tunnel, never
// the start of the instance.
export function readTunnelConfig(home: string): TunnelConfig | null {
  let raw: string;
  try {
    raw = readFileSync(tunnelFile(home), "utf8");
  } catch {
    return null;
  }
  try {
    return tunnelConfigSchema.parse(JSON.parse(raw));
  } catch {
    console.warn(`tunnel.json in ${home} is malformed and was ignored`);
    return null;
  }
}

export function writeTunnelConfig(home: string, config: TunnelConfig): void {
  const file = tunnelFile(home);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
