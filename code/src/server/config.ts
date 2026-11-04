import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Rp } from "./features/auth/api";

export interface Config {
  home: string;
  port: number;
  host: string;
  rp: Rp;
  trustProxy: boolean;
}

const envSchema = z.object({
  HARNESS_HOME: z.string().min(1).default("~/.harness"),
  HARNESS_PORT: z.coerce.number().int().min(0).max(65535).default(4100),
  HARNESS_HOST: z.string().min(1).default("127.0.0.1"),
  // Cookies and passkeys ride on this origin, so plain http is only acceptable on localhost.
  HARNESS_ORIGIN: z
    .url({ protocol: /^https?$/ })
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" || url.hostname === "localhost";
    }, "HARNESS_ORIGIN must be https unless the host is localhost")
    .optional(),
  // Only behind a reverse proxy that sets X-Forwarded-For; otherwise a client could pick its own key.
  HARNESS_TRUST_PROXY: z.stringbool().default(false),
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
    trustProxy: parsed.HARNESS_TRUST_PROXY,
    // WebAuthn rejects IP-address RP IDs, which is why the default is localhost and not 127.0.0.1.
    rp: { id: new URL(origin).hostname, name: "Harness", origin },
  };
}
