import { expect, test } from "bun:test";
import { verify } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicKeyFromRaw, vapidHeader, vapidPublicKey } from "./vapid";

const home = (): string => mkdtempSync(join(tmpdir(), "vapid-"));

test("the key pair is created once and kept", () => {
  const dir = home();
  const first = vapidPublicKey(dir);
  expect(vapidPublicKey(dir)).toBe(first);
  expect(Buffer.from(first, "base64url")).toHaveLength(65);
  expect(vapidPublicKey(home())).not.toBe(first);
});

test("the jwt verifies with the public key, aud is the endpoint origin, exp is within 12 h", () => {
  const dir = home();
  const now = Date.now();
  const header = vapidHeader(dir, "https://push.example.test/send/abc?x=1", "mailto:a@b.test", now);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  if (!m) throw new Error("bad header");
  const [, h, c, s, k] = m as unknown as [string, string, string, string, string];
  expect(k).toBe(vapidPublicKey(dir));
  const ok = verify(
    "sha256",
    Buffer.from(`${h}.${c}`),
    { key: publicKeyFromRaw(Buffer.from(k, "base64url")), dsaEncoding: "ieee-p1363" },
    Buffer.from(s, "base64url"),
  );
  expect(ok).toBe(true);
  const claims = JSON.parse(Buffer.from(c, "base64url").toString()) as { aud: string; exp: number };
  expect(claims.aud).toBe("https://push.example.test");
  expect(claims.exp * 1000 - now).toBeLessThanOrEqual(12 * 3600 * 1000);
  expect(claims.exp * 1000).toBeGreaterThan(now);
});

test("the private half is never part of the header", () => {
  const dir = home();
  const header = vapidHeader(dir, "https://push.example.test/x", "mailto:a@b.test", Date.now());
  const stored = JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8")) as Record<
    string,
    string
  >;
  expect(header).not.toContain(stored["vapid.private"] ?? "missing");
});
