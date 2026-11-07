import type { Database } from "bun:sqlite";
import { randomInt } from "node:crypto";

const TTL_MS = 10 * 60_000;
const MAX_PENDING = 1000;
// No 0/O or 1/I/L: the code is read off a screen and typed into a chat.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LENGTH = 8;

export interface LinkCodes {
  issue(kind: "slack" | "telegram", memberId: string): { code: string; expiresAt: number };
  // One use only: a redeemed or expired code returns null.
  redeem(kind: "slack" | "telegram", code: string): string | null;
}

const digest = (code: string): string =>
  new Bun.CryptoHasher("sha256").update(code.trim().toUpperCase()).digest("hex");

function randomCode(): string {
  return Array.from({ length: LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}

// Memory only: a restart invalidates pending codes, which is fine for a 10 minute window, and
// only hashes are kept so a heap dump does not hand out usable codes.
export function createLinkCodes(now: () => number = Date.now): LinkCodes {
  const pending = new Map<string, { memberId: string; expiresAt: number }>();
  return {
    issue(kind, memberId) {
      for (const [key, entry] of pending) if (entry.expiresAt <= now()) pending.delete(key);
      if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string);
      const code = randomCode();
      const expiresAt = now() + TTL_MS;
      pending.set(`${kind}:${digest(code)}`, { memberId, expiresAt });
      return { code, expiresAt };
    },
    redeem(kind, code) {
      const key = `${kind}:${digest(code)}`;
      const entry = pending.get(key);
      pending.delete(key);
      return entry && entry.expiresAt > now() ? entry.memberId : null;
    },
  };
}

// The route and the poller share one store per db, like notify's dispatcher.
const shared = new WeakMap<Database, LinkCodes>();

export function linkCodesFor(db: Database): LinkCodes {
  let codes = shared.get(db);
  if (!codes) {
    codes = createLinkCodes();
    shared.set(db, codes);
  }
  return codes;
}
