import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export const COOKIE_NAME = "harness_admin";

// The temp file is complete and fsynced before link() publishes it, so <home>/secret never
// exists half-written; link fails with EEXIST instead of replacing a secret another boot made.
function createSecretFile(path: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, randomBytes(32).toString("hex"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  } finally {
    unlinkSync(tmp);
  }
}

export function loadOrCreateSecret(home: string): string {
  const path = join(home, "secret");
  if (!existsSync(path)) createSecretFile(path);
  chmodSync(path, 0o600);
  const secret = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(secret)) {
    throw new Error(`${path} is not a 64-char hex secret; delete it to generate a new one`);
  }
  return secret;
}

// The cookie carries an HMAC of a fixed label, so the secret itself never leaves the server.
export function sessionValue(secret: string): string {
  return createHmac("sha256", secret).update("harness-admin-session").digest("hex");
}

// Both sides are HMACed first so the compare is constant-time and length-independent.
export function safeEqual(a: string, b: string): boolean {
  const key = randomBytes(32);
  const digest = (value: string): Buffer => createHmac("sha256", key).update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}
