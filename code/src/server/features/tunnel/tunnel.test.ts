import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootApi } from "../../test-support/api-kit";
import { withActor } from "../../test-support/app-kit";
import { createTunnel, tunnelRoutes } from "./api";
import { FAKE_BIN, PORT, post, setup, trackTunnel, tunnelJson } from "./test-kit";

test("GET detects tailscale and cloudflared and lists the exact commands without running them", async () => {
  const { app, calls } = setup();
  const res = await app.request("/");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    detected: {
      tailscale: { installed: boolean; dnsName: string };
      cloudflared: { installed: boolean };
    };
    config: unknown;
    running: unknown;
    commands: Record<string, { start: string; stop: string | null }>;
  };
  expect(body.detected.tailscale).toEqual({ installed: true, dnsName: "mac.tail1234.ts.net" });
  expect(body.detected.cloudflared.installed).toBe(true);
  expect(body.config).toBeNull();
  expect(body.running).toBeNull();
  expect(body.commands["tailscale-serve"]).toEqual({
    start: `tailscale serve --bg ${PORT}`,
    stop: `tailscale serve --bg ${PORT} off`,
  });
  expect(body.commands["tailscale-funnel"]).toEqual({
    start: `tailscale funnel --bg ${PORT}`,
    stop: `tailscale funnel --bg ${PORT} off`,
  });
  expect(body.commands.cloudflare).toEqual({
    start: `cloudflared tunnel --url http://127.0.0.1:${PORT}`,
    stop: null,
  });
  expect(calls()).toBe("tailscale status --json\n");
});

test("GET reports missing binaries", async () => {
  const home = mkdtempSync(join(tmpdir(), "harness-tunnel-"));
  const tunnel = createTunnel({ home, port: PORT, bin: join(home, "empty") });
  const res = await withActor(tunnelRoutes(tunnel, home)).request("/");
  const body = (await res.json()) as {
    detected: { tailscale: { installed: boolean; dnsName: null } };
  };
  expect(body.detected.tailscale).toEqual({ installed: false, dnsName: null });
});

test("setup writes tunnel.json only and starts nothing", async () => {
  const { app, home, calls } = setup({ stepUpAt: Date.now() });
  const res = await post(app, "/setup", {
    provider: "tailscale-serve",
    hostname: "mac.tail1234.ts.net",
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { restartRequired: boolean; warning: string };
  expect(body.restartRequired).toBe(true);
  expect(body.warning).toContain("passkey");
  expect(body.warning).toContain("mac.tail1234.ts.net");
  expect(tunnelJson(home)).toEqual({
    provider: "tailscale-serve",
    origin: "https://mac.tail1234.ts.net",
  });
  expect(calls()).toBe("");
});

test("setup needs a hostname for tailscale, and a bad hostname is refused", async () => {
  const { app, home } = setup({ stepUpAt: Date.now() });
  expect((await post(app, "/setup", { provider: "tailscale-serve" })).status).toBe(400);
  expect((await post(app, "/setup", { provider: "cloudflare", hostname: "a/b" })).status).toBe(400);
  expect((await post(app, "/setup", { provider: "ngrok" })).status).toBe(400);
  expect(existsSync(join(home, "tunnel.json"))).toBe(false);
});

test("setup, start and stop all need a fresh step-up", async () => {
  const { app, calls } = setup({ stepUpAt: Date.now() - 60 * 60 * 1000 });
  expect((await post(app, "/setup", { provider: "cloudflare" })).status).toBe(403);
  expect((await post(app, "/start", { confirm: true })).status).toBe(403);
  expect((await app.request("/", { method: "DELETE" })).status).toBe(403);
  expect(calls()).toBe("");
});

test("only an instance admin reaches the routes", async () => {
  const api = bootApi();
  const member = await api.user({ stepUp: true });
  expect((await api.call(member, "GET", "/api/tunnel")).status).toBe(403);
  expect((await api.call(member, "POST", "/api/tunnel/start", { confirm: true })).status).toBe(403);
  const admin = await api.user({ admin: true, stepUp: true });
  expect((await api.call(admin, "GET", "/api/tunnel")).status).toBe(200);
});

test("start without a stored setup, or without confirm, runs nothing", async () => {
  const { app, calls } = setup({ stepUpAt: Date.now() });
  expect((await post(app, "/start", { confirm: true })).status).toBe(400);
  await post(app, "/setup", { provider: "tailscale-serve", hostname: "mac.tail1234.ts.net" });
  expect((await post(app, "/start", {})).status).toBe(400);
  expect((await post(app, "/start", { confirm: false })).status).toBe(400);
  expect(calls()).toBe("");
});

test("public providers need confirmPublic, and nothing runs without it", async () => {
  for (const provider of ["tailscale-funnel", "cloudflare"]) {
    const { app, calls, tunnel } = setup({ stepUpAt: Date.now() });
    await post(app, "/setup", { provider, hostname: "mac.tail1234.ts.net" });
    expect((await post(app, "/start", { confirm: true })).status).toBe(400);
    expect((await post(app, "/start", { confirm: true, confirmPublic: false })).status).toBe(400);
    expect(calls()).toBe("");
    expect(tunnel.running()).toBeNull();
  }
});

test("start serve runs tailscale serve --bg with the port, and stop disables that port", async () => {
  const { app, calls, tunnel } = setup({ stepUpAt: Date.now() });
  await post(app, "/setup", { provider: "tailscale-serve", hostname: "mac.tail1234.ts.net" });
  const res = await post(app, "/start", { confirm: true });
  expect(res.status).toBe(200);
  expect(calls()).toBe(`tailscale serve --bg ${PORT}\n`);
  expect(tunnel.running()).toBe("tailscale-serve");
  expect((await post(app, "/start", { confirm: true })).status).toBe(409);
  expect((await app.request("/", { method: "DELETE" })).status).toBe(200);
  expect(calls()).toBe(
    `tailscale serve --bg ${PORT}\ntailscale serve status --json\ntailscale serve --bg ${PORT} off\n`,
  );
  expect(tunnel.running()).toBeNull();
});

test("start funnel with confirmPublic runs tailscale funnel --bg, stop disables that port", async () => {
  const { app, calls } = setup({ stepUpAt: Date.now() });
  await post(app, "/setup", { provider: "tailscale-funnel", hostname: "mac.tail1234.ts.net" });
  expect((await post(app, "/start", { confirm: true, confirmPublic: true })).status).toBe(200);
  await app.request("/", { method: "DELETE" });
  expect(calls()).toBe(
    `tailscale funnel --bg ${PORT}\ntailscale funnel status --json\ntailscale funnel --bg ${PORT} off\n`,
  );
});

test("status timeout kills an unresponsive Tailscale process before cleanup", async () => {
  const { tunnel, calls } = setup({
    env: { FAKE_TAILSCALE_HANG_STATUS: "1" },
    statusTimeoutMs: 25,
  });
  expect((await tunnel.start("tailscale-serve")).ok).toBe(true);
  expect(await tunnel.stop()).toMatchObject({ ok: false, status: 409 });
  expect(calls()).toBe("tailscale serve --bg 4100\ntailscale serve status --json\n");
  expect(tunnel.running()).toBe("tailscale-serve");
});

test("a failing tailscale start is reported and leaves nothing marked running", async () => {
  const { app, tunnel } = setup({ stepUpAt: Date.now(), env: { FAKE_TAILSCALE_FAIL: "1" } });
  await post(app, "/setup", { provider: "tailscale-serve", hostname: "mac.tail1234.ts.net" });
  const res = await post(app, "/start", { confirm: true });
  expect(res.status).toBe(502);
  expect(tunnel.running()).toBeNull();
});

test("cloudflare start parses the quick tunnel url from stderr and stop leaves no process", async () => {
  const { app, home, calls, tunnel } = setup({ stepUpAt: Date.now() });
  await post(app, "/setup", { provider: "cloudflare" });
  const res = await post(app, "/start", { confirm: true, confirmPublic: true });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { origin: string; restartRequired: boolean };
  expect(body.origin).toBe("https://quiet-fake-words.trycloudflare.com");
  expect(body.restartRequired).toBe(true);
  expect(tunnelJson(home)).toEqual({ provider: "cloudflare", origin: body.origin });
  expect(calls()).toContain(`cloudflared tunnel --url http://127.0.0.1:${PORT}\n`);
  const pid = Number(/pid (\d+)/.exec(calls())?.[1]);
  expect(() => process.kill(pid, 0)).not.toThrow();
  expect((await app.request("/", { method: "DELETE" })).status).toBe(200);
  expect(tunnel.running()).toBeNull();
  await Bun.sleep(100);
  expect(() => process.kill(pid, 0)).toThrow();
});

test("concurrent starts launch only one cloudflared child", async () => {
  const { calls, tunnel } = setup();
  const results = await Promise.all([tunnel.start("cloudflare"), tunnel.start("cloudflare")]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)).toMatchObject({ status: 409 });
  expect((calls().match(/pid /g) ?? []).length).toBe(1);
});

test("concurrent stops share cleanup and do not clear a replacement tunnel", async () => {
  const { calls, tunnel } = setup({ env: { FAKE_TAILSCALE_DELAY_STOP: "1" } });
  expect((await tunnel.start("tailscale-serve")).ok).toBe(true);
  const firstStop = tunnel.stop();
  const secondStop = tunnel.stop();
  await firstStop;
  expect((await tunnel.start("cloudflare")).ok).toBe(true);
  await secondStop;
  expect(tunnel.running()).toBe("cloudflare");
  expect(calls().match(/tailscale serve --bg 4100 off/g)).toHaveLength(1);
  await tunnel.stop();
});

test("stop waits for an in-flight cloudflare start then kills its child", async () => {
  const { calls, tunnel } = setup();
  const starting = tunnel.start("cloudflare");
  const stopping = tunnel.stop();
  const [startResult, stopResult] = await Promise.all([starting, stopping]);
  expect(startResult.ok).toBe(true);
  expect(stopResult.ok).toBe(true);
  expect(tunnel.running()).toBeNull();
  const pid = Number(/pid (\d+)/.exec(calls())?.[1]);
  expect(() => process.kill(pid, 0)).toThrow();
});

test("a cloudflared child is stopped when saving its origin fails", async () => {
  const { home, calls } = setup();
  const tunnel = createTunnel({
    home: join(home, "missing"),
    port: PORT,
    bin: FAKE_BIN,
    env: { FAKE_BIN_LOG: join(home, "calls.log") },
    urlTimeoutMs: 5000,
  });
  trackTunnel(tunnel);
  const result = await tunnel.start("cloudflare");
  expect(result).toMatchObject({ ok: false, status: 502 });
  const pid = Number(/pid (\d+)/.exec(calls())?.[1]);
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
  expect(tunnel.running()).toBeNull();
});

test("a stderr reader failure stops the cloudflared child", async () => {
  const { calls, tunnel } = setup();
  const read = spyOn(ReadableStreamDefaultReader.prototype, "read").mockImplementation(async () => {
    while (!calls().includes("pid ")) await Bun.sleep(1);
    throw new Error("stderr read failed");
  });
  try {
    expect(await tunnel.start("cloudflare")).toMatchObject({
      ok: false,
      status: 502,
      error: "cloudflared could not provide a tunnel url",
    });
  } finally {
    read.mockRestore();
  }
  const pid = Number(/pid (\d+)/.exec(calls())?.[1]);
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
  expect(tunnel.running()).toBeNull();
});

test("shutdown rejects a tunnel start before spawning a child", async () => {
  const { app, calls, tunnel } = setup({ stepUpAt: Date.now() });
  await post(app, "/setup", { provider: "cloudflare" });
  tunnel.beginShutdown();
  expect((await post(app, "/start", { confirm: true, confirmPublic: true })).status).toBe(409);
  expect(calls()).toBe("");
});

test("stop without a running tunnel leaves stored Tailscale configuration alone", async () => {
  const { app, calls } = setup({ stepUpAt: Date.now() });
  await post(app, "/setup", { provider: "tailscale-funnel", hostname: "mac.tail1234.ts.net" });
  expect((await app.request("/", { method: "DELETE" })).status).toBe(200);
  expect(calls()).toBe("");
});
