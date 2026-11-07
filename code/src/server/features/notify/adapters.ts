import type { Database } from "bun:sqlite";
import type { Channel } from "../../../shared/notify";
import { emailNotifier } from "./email/adapter";
import type { Notifier } from "./port";
import { pushNotifier } from "./push/adapter";
import { slackNotifier } from "./slack/adapter";
import { telegramNotifier } from "./telegram/adapter";
import { webhookNotifier } from "./webhook/adapter";

// Adapters read their secrets from the secrets file under `home`, so they are built per instance.
export interface AdapterEnv {
  db: Database;
  home: string;
}

export function buildAdapters(env: AdapterEnv): Record<Channel, Notifier> {
  return {
    push: pushNotifier(env),
    email: emailNotifier(env),
    slack: slackNotifier(env.home),
    telegram: telegramNotifier(env.home),
    webhook: webhookNotifier(env.home),
  };
}
