import { expect, test } from "bun:test";
import { setup } from "./test-kit";

test("stop preserves a Tailscale mapping whose backend changed", async () => {
  const { tunnel, calls } = setup({ env: { FAKE_TAILSCALE_BACKEND: "http://127.0.0.1:9999" } });
  expect((await tunnel.start("tailscale-serve")).ok).toBe(true);
  expect(await tunnel.stop()).toMatchObject({ ok: false, status: 409 });
  expect(calls()).toBe("tailscale serve --bg 4100\ntailscale serve status --json\n");
  expect(tunnel.running()).toBe("tailscale-serve");
});

test("stop preserves a Tailscale listener with another configured path", async () => {
  const { tunnel, calls } = setup({
    env: {
      FAKE_TAILSCALE_BACKEND: "http://127.0.0.1:9999",
      FAKE_TAILSCALE_EXTRA_PATH: "/other",
    },
  });
  expect((await tunnel.start("tailscale-serve")).ok).toBe(true);
  expect(await tunnel.stop()).toMatchObject({ ok: false, status: 409 });
  expect(calls()).toBe("tailscale serve --bg 4100\ntailscale serve status --json\n");
  expect(tunnel.running()).toBe("tailscale-serve");
});

test("stop preserves a Tailscale listener on another HTTPS port", async () => {
  const { tunnel, calls } = setup({ env: { FAKE_TAILSCALE_WEB_KEY: "mac.tail1234.ts.net:8443" } });
  expect((await tunnel.start("tailscale-funnel")).ok).toBe(true);
  expect(await tunnel.stop()).toMatchObject({ ok: false, status: 409 });
  expect(calls()).toBe("tailscale funnel --bg 4100\ntailscale funnel status --json\n");
  expect(tunnel.running()).toBe("tailscale-funnel");
});

test("stop leaves unrelated Tailscale listeners and paths in place", async () => {
  const { tunnel, calls } = setup({
    env: {
      FAKE_TAILSCALE_EXTRA_PATH: "/other",
      FAKE_TAILSCALE_EXTRA_WEB_KEY: "mac.tail1234.ts.net:8443",
    },
  });
  expect((await tunnel.start("tailscale-serve")).ok).toBe(true);
  expect(await tunnel.stop()).toMatchObject({ ok: true });
  expect(calls()).toBe(
    "tailscale serve --bg 4100\ntailscale serve status --json\ntailscale serve --bg 4100 off\n",
  );
});

test("stop refuses a Tailscale listener whose Serve or Funnel mode changed", async () => {
  const { tunnel, calls } = setup({ env: { FAKE_TAILSCALE_ALLOW_FUNNEL: "1" } });
  expect((await tunnel.start("tailscale-serve")).ok).toBe(true);
  expect(await tunnel.stop()).toMatchObject({ ok: false, status: 409 });
  expect(calls()).toBe("tailscale serve --bg 4100\ntailscale serve status --json\n");
});

test("stop refuses an HTTP listener that replaced the HTTPS mapping", async () => {
  const { tunnel, calls } = setup({ env: { FAKE_TAILSCALE_HTTP_443: "1" } });
  expect((await tunnel.start("tailscale-serve")).ok).toBe(true);
  expect(await tunnel.stop()).toMatchObject({ ok: false, status: 409 });
  expect(calls()).toBe("tailscale serve --bg 4100\ntailscale serve status --json\n");
});
