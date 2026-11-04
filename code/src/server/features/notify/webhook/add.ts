import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { z } from "zod";
import { setSecret } from "../../agents/api";
import { insertTarget } from "../targets-repo";
import { webhookUrlProblem } from "./ssrf";

export interface WebhookTargetBody {
  channel: "webhook";
  url: string;
  secret?: string | undefined;
}

export const webhookTargetBody: z.ZodType<WebhookTargetBody> = z.object({
  channel: z.literal("webhook"),
  url: z.string().max(2000),
  secret: z.string().min(16).max(200).optional(),
});

const REPLAY_NOTE =
  "Verify X-Harness-Signature over the X-Harness-Timestamp value, a dot, then the raw request body, and reject timestamps older than 5 minutes. The secret is shown only once.";

// The secret is returned here and nowhere else: targets are listed by url only.
export async function addWebhookTarget(
  c: Context,
  db: Database,
  home: string | undefined,
  memberId: string,
  body: WebhookTargetBody,
): Promise<Response> {
  const problem = await webhookUrlProblem(body.url);
  if (problem) return c.json({ error: problem }, 400);
  const id = Bun.randomUUIDv7();
  const secretName = `webhook.${id}`;
  const secret =
    body.secret ?? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  setSecret(secretName, secret, home);
  insertTarget(db, memberId, "webhook", { url: body.url, secretName }, id);
  return c.json({ id, secret, note: REPLAY_NOTE }, 201);
}
