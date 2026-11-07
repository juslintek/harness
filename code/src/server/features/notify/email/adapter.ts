import type { Database } from "bun:sqlite";
import type { DeliverResult } from "../../../../shared/notify";
import { getSecret } from "../../agents/api";
import type { Notifier } from "../port";
import { loadSmtpConfig, type SmtpConfig } from "./config";
import { type Mail, SmtpError, sendMail } from "./smtp";

export const SMTP_PASSWORD_SECRET = "smtp.password";

export async function sendConfigured(
  cfg: SmtpConfig,
  home: string,
  mail: Mail,
): Promise<DeliverResult> {
  const password = getSecret(SMTP_PASSWORD_SECRET, home);
  try {
    await sendMail(cfg, mail, password ? { password } : {});
    return { ok: true };
  } catch (err) {
    if (err instanceof SmtpError) return { ok: false, retry: err.retry, reason: err.message };
    return { ok: false, retry: false, reason: "smtp failed" };
  }
}

// Config is read per delivery, so a change made in the UI applies without a restart.
export function emailNotifier(env: { db: Database; home: string }): Notifier {
  return {
    channel: "email",
    async deliver(target, n, base) {
      const cfg = loadSmtpConfig(env.db);
      if (!cfg) return { ok: false, retry: false, reason: "not configured" };
      const title = n.title.replace(/\s+/g, " ").trim();
      return sendConfigured(cfg, env.home, {
        to: target.value.address ?? "",
        subject: `[harness] ${title}`,
        text: `${n.body}\n\n${base}${n.path}`,
      });
    },
  };
}

// Null while SMTP is unconfigured, so the caller keeps its own fallback. A failed send is logged
// without the code: it is a sign-in credential.
export function emailCodeSender(
  db: Database,
  home: string,
): ((email: string, code: string) => Promise<void>) | null {
  const cfg = loadSmtpConfig(db);
  if (!cfg) return null;
  return async (email, code) => {
    try {
      const result = await sendConfigured(cfg, home, {
        to: email,
        subject: "[harness] your sign-in code",
        text: `Your harness sign-in code is ${code}.`,
      });
      if (!result.ok) console.error("email code delivery failed");
    } catch {
      console.error("email code delivery failed");
    }
  };
}
