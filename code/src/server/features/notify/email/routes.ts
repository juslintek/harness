import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { z } from "zod";
import { parseBody } from "../../../route-kit";
import { setSecret } from "../../agents/api";
import { type AuthEnv, getUser, requireInstanceAdmin, requireStepUp } from "../../auth/api";
import { SMTP_PASSWORD_SECRET, sendConfigured } from "./adapter";
import { loadSmtpConfig, saveSmtpConfig, smtpConfigSchema } from "./config";

const configBody = z.intersection(
  smtpConfigSchema,
  z.object({ password: z.string().min(1).max(500).optional() }),
);

export function emailRoutes(db: Database, home: string): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("*", requireInstanceAdmin);
  app.put("/config", requireStepUp, async (c) => {
    const body = await parseBody(c, configBody);
    if (body instanceof Response) return body;
    const { password, ...cfg } = body;
    saveSmtpConfig(db, cfg);
    if (password) setSecret(SMTP_PASSWORD_SECRET, password, home);
    return c.json({ ok: true });
  });
  app.post("/test", async (c) => {
    const cfg = loadSmtpConfig(db);
    const user = getUser(db, c.get("actor").userId);
    if (!cfg || !user) return c.json({ error: "not configured" }, 400);
    const result = await sendConfigured(cfg, home, {
      to: user.email,
      subject: "[harness] test email",
      text: "SMTP is set up. This message was sent from the harness settings.",
    });
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.reason }, 502);
  });
  return app;
}
