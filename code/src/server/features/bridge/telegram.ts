import type { Database } from "bun:sqlite";
import {
  addTarget,
  getTelegramUpdates,
  sendTelegramMessage,
  type TelegramUpdate,
} from "../notify/api";
import { MAX_BACKOFF_MS, MIN_BACKOFF_MS, type Sleep, waitFor } from "./backoff";
import { type Echo, handleInbound } from "./inbound";
import type { LinkCodes } from "./link-codes";
import { linkExternalUser } from "./repo";

export interface PollOptions {
  db: Database;
  home: string;
  echo: Echo;
  codes: LinkCodes;
  sleep?: Sleep;
}

type Message = NonNullable<TelegramUpdate["message"]>;

const LINK_COMMAND = /^\/link(?:@\w+)?\s+(\S+)/i;

async function reply(opts: PollOptions, chatId: number, text: string): Promise<void> {
  const sent = await sendTelegramMessage(opts.home, String(chatId), text);
  if (!sent.ok) console.error("telegram bridge: reply failed:", sent.reason);
}

// Linking also stores a push-style notify target, so the same /link gives the member DMs.
async function link(opts: PollOptions, msg: Message, from: number, code: string): Promise<void> {
  const memberId = opts.codes.redeem(code);
  if (!memberId) {
    await reply(opts, msg.chat.id, "That code is invalid or expired. Create a new one in the app.");
    return;
  }
  linkExternalUser(opts.db, "telegram", String(from), memberId);
  addTarget(opts.db, memberId, "telegram", { chatId: String(msg.chat.id) });
  await reply(opts, msg.chat.id, "Linked. Your messages in bridged groups now appear in the app.");
}

async function handleUpdate(opts: PollOptions, update: TelegramUpdate): Promise<void> {
  const msg = update.message;
  if (!msg?.from || msg.from.is_bot || !msg.text) return;
  if (msg.chat.type === "private") {
    const code = LINK_COMMAND.exec(msg.text)?.[1];
    if (code) await link(opts, msg, msg.from.id, code);
    return;
  }
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") return;
  handleInbound(opts.db, opts.echo, {
    kind: "telegram",
    externalChannel: String(msg.chat.id),
    externalUser: String(msg.from.id),
    text: msg.text,
  });
}

// One bad update must not stop the loop, and it still counts as seen so it is not retried.
async function handleAll(opts: PollOptions, updates: TelegramUpdate[]): Promise<number | null> {
  let next: number | null = null;
  for (const update of updates) {
    try {
      await handleUpdate(opts, update);
    } catch (err) {
      console.error("telegram bridge: update failed", err instanceof Error ? err.name : "unknown");
    }
    next = update.update_id + 1;
  }
  return next;
}

// Outbound-only like the Slack socket: the app asks Telegram for updates, so no public URL is
// needed. Confirming an offset is what stops Telegram from redelivering an update.
export function startTelegramPoll(opts: PollOptions): () => Promise<void> {
  const stop = new AbortController();
  const sleep = opts.sleep ?? waitFor;
  const loop = (async () => {
    let offset = 0;
    let delay = MIN_BACKOFF_MS;
    while (!stop.signal.aborted) {
      const res = await getTelegramUpdates(opts.home, offset, stop.signal);
      if (res.ok) {
        delay = MIN_BACKOFF_MS;
        offset = (await handleAll(opts, res.updates)) ?? offset;
        continue;
      }
      if (stop.signal.aborted) break;
      console.error("telegram bridge: poll failed:", res.reason);
      await sleep(delay, stop.signal);
      delay = Math.min(delay * 2, MAX_BACKOFF_MS);
    }
  })();
  return async () => {
    stop.abort();
    await loop;
  };
}
