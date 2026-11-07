import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTunnel, type Tunnel } from "./features/tunnel/api";
import { createOriginApp } from "./origin-app";
import { bootApi } from "./test-support/api-kit";
import { listenDeferred, sessionHeaders } from "./test-support/app-kit";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const { db } = bootApi();
  const home = mkdtempSync(join(tmpdir(), "harness-origin-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const log = join(home, "tunnel.log");
  writeFileSync(log, "");
  const listener = listenDeferred();
  cleanups.push(() => listener.server.stop(true));
  const local = `http://localhost:${listener.port}`;
  const who = await sessionHeaders(db, { admin: true, stepUp: true, origin: local });
  const mount = (nextCloudflareOrigin?: string): Tunnel => {
    const tunnel = createTunnel({
      home,
      port: listener.port,
      bin: join(import.meta.dir, "test-support/fake-bin"),
      env: {
        FAKE_BIN_LOG: log,
        FAKE_TAILSCALE_BACKEND: `http://127.0.0.1:${listener.port}`,
        ...(nextCloudflareOrigin ? { FAKE_CLOUDFLARE_ORIGIN: nextCloudflareOrigin } : {}),
      },
    });
    cleanups.push(async () => {
      await tunnel.stop();
    });
    listener.attach(
      createOriginApp(
        {
          db,
          home,
          port: listener.port,
          rp: { id: "localhost", name: "Harness", origin: local },
          instanceId: "i",
          version: "1",
          tunnel,
        },
        () => tunnel.origin() ?? local,
      ),
    );
    return tunnel;
  };
  const request = (host: string, path: string, body?: object, extra: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${listener.port}${path}`, {
      method: body ? "POST" : "GET",
      headers: { ...who.headers, host, origin: `https://${host}`, ...extra },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const call = (path: string, body?: object) =>
    request(new URL(local).host, path, body, { origin: local });
  return { mount, request, call, local, calls: () => readFileSync(log, "utf8") };
}

async function restart(
  kit: Awaited<ReturnType<typeof setup>>,
  hostname: string,
  cloudflare: boolean,
) {
  const beforeRestart = kit.calls();
  const restarted = kit.mount("https://new-fake-origin.trycloudflare.com");
  expect(restarted.origin()).toBeNull();
  expect(kit.calls()).toBe(beforeRestart);
  expect((await kit.call("/api/tunnel/start", { confirm: true, confirmPublic: true })).status).toBe(
    200,
  );
  const nextHostname = cloudflare ? "new-fake-origin.trycloudflare.com" : hostname;
  expect(
    (await (await kit.request(nextHostname, "/.well-known/oauth-authorization-server")).json())
      .issuer,
  ).toBe(`https://${nextHostname}`);
  if (cloudflare)
    expect((await kit.request(hostname, "/.well-known/oauth-authorization-server")).status).toBe(
      403,
    );
  expect((await kit.call("/api/health")).status).toBe(200);
}

test.each(["tailscale-serve", "tailscale-funnel", "cloudflare"] as const)(
  "%s changes its public RP without a restart and keeps local recovery",
  async (provider) => {
    const kit = await setup();
    const tunnel = kit.mount();
    const hostname =
      provider === "cloudflare" ? "quiet-fake-words.trycloudflare.com" : "mac.tail1234.ts.net";
    expect((await kit.call("/api/tunnel/setup", { provider, hostname })).status).toBe(200);
    expect(kit.calls()).toBe("");
    expect((await kit.request(hostname, "/.well-known/oauth-authorization-server")).status).toBe(
      403,
    );
    const started = await kit.call("/api/tunnel/start", { confirm: true, confirmPublic: true });
    expect(started.status).toBe(200);
    expect((await started.json()).restartRequired).toBe(false);
    expect(tunnel.origin()).toBe(`https://${hostname}`);
    const metadata = await kit.request(
      hostname,
      "/.well-known/oauth-authorization-server",
      undefined,
      { "x-forwarded-proto": "https" },
    );
    expect(metadata.status).toBe(200);
    expect((await metadata.json()).issuer).toBe(`https://${hostname}`);
    const assertion = await kit.request(hostname, "/api/auth/step-up/options", {});
    expect(assertion.status).toBe(200);
    expect((await assertion.json()).rpId).toBe(hostname);
    expect(
      (await kit.call("/api/tunnel/setup", { provider, hostname: "other.example" })).status,
    ).toBe(409);
    expect((await kit.call("/api/health")).status).toBe(200);
    expect(
      (
        await kit.request(new URL(kit.local).host, "/api/health", undefined, {
          forwarded: "host=remote.example",
        })
      ).status,
    ).toBe(403);
    expect((await tunnel.stop()).ok).toBe(true);
    expect((await kit.request(hostname, "/.well-known/oauth-authorization-server")).status).toBe(
      403,
    );
    expect((await kit.call("/api/health")).status).toBe(200);
    await restart(kit, hostname, provider === "cloudflare");
  },
);
