import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Both sides are HMACed first so the compare is constant-time and length-independent.
export function safeEqual(a: string, b: string): boolean {
  const key = randomBytes(32);
  const digest = (value: string): Buffer => createHmac("sha256", key).update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}
