import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Rp } from "./features/auth/api";

export interface Config {
  home: string;
  port: number;
  host: string;
  rp: Rp;
}

const envSchema = z.object({
  HARNESS_HOME: z.string().min(1).default("~/.harness"),
  HARNESS_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  HARNESS_HOST: z.string().min(1).default("127.0.0.1"),
  HARNESS_ORIGIN: z.url({ protocol: /^https?$/ }).optional(),
});

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.parse(env);
  const origin = new URL(parsed.HARNESS_ORIGIN ?? `http://localhost:${parsed.HARNESS_PORT}`).origin;
  return {
    home: expandHome(parsed.HARNESS_HOME),
    port: parsed.HARNESS_PORT,
    host: parsed.HARNESS_HOST,
    // WebAuthn rejects IP-address RP IDs, which is why the default is localhost and not 127.0.0.1.
    rp: { id: new URL(origin).hostname, name: "Harness", origin },
  };
}
