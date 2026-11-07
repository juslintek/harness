import type { Database } from "bun:sqlite";
import { z } from "zod";

export interface SmtpConfig {
  host: string;
  port: number;
  security: "starttls" | "tls" | "none";
  user?: string | undefined;
  from: string;
}

export const smtpConfigSchema: z.ZodType<SmtpConfig> = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  security: z.enum(["starttls", "tls", "none"]),
  user: z.string().min(1).max(200).optional(),
  from: z.string().min(3).max(320),
});

const KEYS = ["host", "port", "security", "user", "from"] as const;

export function loadSmtpConfig(db: Database): SmtpConfig | null {
  const rows = db
    .query<{ key: string; value: string }, []>(
      "SELECT key, value FROM notify_settings WHERE key LIKE 'email.%'",
    )
    .all();
  const raw: Record<string, string | number> = {};
  for (const { key, value } of rows) raw[key.slice("email.".length)] = value;
  if (raw.port !== undefined) raw.port = Number(raw.port);
  const parsed = smtpConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function saveSmtpConfig(db: Database, cfg: SmtpConfig): void {
  db.transaction(() => {
    for (const key of KEYS) {
      const value = cfg[key];
      if (value === undefined) {
        db.query("DELETE FROM notify_settings WHERE key = ?").run(`email.${key}`);
        continue;
      }
      db.query(
        "INSERT INTO notify_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(`email.${key}`, String(value));
    }
  })();
}
