import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Rp } from "./features/auth/api";
import { readTunnelConfig } from "./features/tunnel/api";

export interface Config {
  home: string;
  port: number;
  host: string;
  rp: Rp;
  trustProxy: boolean;
}

// Cookies and passkeys ride on this origin, so plain http is only acceptable on localhost.
const originSchema = z.url({ protocol: /^https?$/ }).refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" || url.hostname === "localhost";
}, "origin must be https unless the host is localhost");

const envSchema = z.object({
  HARNESS_HOME: z.string().min(1).default("~/.harness"),
  HARNESS_PORT: z.coerce.number().int().min(0).max(65535).default(4100),
  HARNESS_HOST: z.string().min(1).default("127.0.0.1"),
  HARNESS_ORIGIN: originSchema.optional(),
  // Only behind a reverse proxy that sets X-Forwarded-For; otherwise a client could pick its own key.
  HARNESS_TRUST_PROXY: z.stringbool().default(false),
});

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

// The origin a tunnel setup stored; an explicit HARNESS_ORIGIN always wins and skips this. A value
// that fails the origin rules is dropped with a warning so a bad file cannot stop the instance.
function tunnelOrigin(home: string): string | undefined {
  const stored = readTunnelConfig(home)?.origin;
  if (stored === undefined) return undefined;
  if (originSchema.safeParse(stored).success) return stored;
  console.warn("tunnel.json holds an origin that is not https or localhost and was ignored");
  return undefined;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.parse(env);
  const home = expandHome(parsed.HARNESS_HOME);
  const configured =
    parsed.HARNESS_ORIGIN ?? tunnelOrigin(home) ?? `http://localhost:${parsed.HARNESS_PORT}`;
  const origin = new URL(configured).origin;
  return {
    home,
    port: parsed.HARNESS_PORT,
    host: parsed.HARNESS_HOST,
    trustProxy: parsed.HARNESS_TRUST_PROXY,
    // WebAuthn rejects IP-address RP IDs, which is why the default is localhost and not 127.0.0.1.
    rp: { id: new URL(origin).hostname, name: "Harness", origin },
  };
}
