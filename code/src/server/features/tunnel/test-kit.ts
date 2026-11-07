import { afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { withActor } from "../../test-support/app-kit";
import type { AuthEnv } from "../auth/api";
import { createTunnel, type Tunnel, tunnelRoutes } from "./api";

export const FAKE_BIN: string = join(import.meta.dir, "../../test-support/fake-bin");
export const PORT: number = 4100;

const tunnels: Tunnel[] = [];
afterEach(async () => {
  for (const tunnel of tunnels.splice(0)) await tunnel.stop();
});

export function trackTunnel(tunnel: Tunnel): void {
  tunnels.push(tunnel);
}

export function setup(
  opts: { stepUpAt?: number; env?: Record<string, string>; statusTimeoutMs?: number } = {},
): {
  app: Hono<AuthEnv>;
  home: string;
  calls: () => string;
  tunnel: Tunnel;
} {
  const home = mkdtempSync(join(tmpdir(), "harness-tunnel-"));
  const log = join(home, "calls.log");
  writeFileSync(log, "");
  const tunnel = createTunnel({
    home,
    port: PORT,
    bin: FAKE_BIN,
    env: { FAKE_BIN_LOG: log, ...opts.env },
    ...(opts.statusTimeoutMs === undefined ? {} : { statusTimeoutMs: opts.statusTimeoutMs }),
    urlTimeoutMs: 5000,
  });
  trackTunnel(tunnel);
  const session = opts.stepUpAt === undefined ? {} : { stepUpAt: opts.stepUpAt };
  return {
    app: withActor(tunnelRoutes(tunnel, home), session),
    home,
    calls: () => readFileSync(log, "utf8"),
    tunnel,
  };
}

export const post = (app: Hono<AuthEnv>, path: string, body: unknown): Promise<Response> =>
  Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

export const tunnelJson = (home: string): unknown =>
  JSON.parse(readFileSync(join(home, "tunnel.json"), "utf8"));
