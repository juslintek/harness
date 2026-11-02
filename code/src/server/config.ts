import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export interface Config {
  home: string;
  port: number;
  host: string;
}

const envSchema = z.object({
  HARNESS_HOME: z.string().min(1).default("~/.harness"),
  HARNESS_PORT: z.coerce.number().int().min(0).max(65535).default(4100),
  HARNESS_HOST: z.string().min(1).default("127.0.0.1"),
});

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.parse(env);
  return {
    home: expandHome(parsed.HARNESS_HOME),
    port: parsed.HARNESS_PORT,
    host: parsed.HARNESS_HOST,
  };
}
