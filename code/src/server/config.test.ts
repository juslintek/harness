import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";

// The origin is pinned so a tunnel.json in the developer's real ~/.harness cannot change the result.
test("defaults expand ~ and use port 4100", () => {
  expect(loadConfig({ HARNESS_ORIGIN: "http://localhost:4100" })).toEqual({
    home: join(homedir(), ".harness"),
    port: 4100,
    host: "127.0.0.1",
    trustProxy: false,
    rp: { id: "localhost", name: "Harness", origin: "http://localhost:4100" },
  });
});

test("env overrides", () => {
  expect(loadConfig({ HARNESS_HOME: "/x", HARNESS_PORT: "5000", HARNESS_HOST: "0.0.0.0" })).toEqual(
    {
      home: "/x",
      port: 5000,
      host: "0.0.0.0",
      trustProxy: false,
      rp: { id: "localhost", name: "Harness", origin: "http://localhost:5000" },
    },
  );
});

test("HARNESS_ORIGIN sets the relying party and drops any path", () => {
  const rp = loadConfig({ HARNESS_ORIGIN: "https://harness.example.com/x" }).rp;
  expect(rp).toEqual({
    id: "harness.example.com",
    name: "Harness",
    origin: "https://harness.example.com",
  });
  expect(() => loadConfig({ HARNESS_ORIGIN: "ftp://harness.example.com" })).toThrow();
});

test("HARNESS_ORIGIN allows http only on localhost", () => {
  expect(loadConfig({ HARNESS_ORIGIN: "http://localhost:4100" }).rp.origin).toBe(
    "http://localhost:4100",
  );
  expect(() => loadConfig({ HARNESS_ORIGIN: "http://harness.example.com" })).toThrow();
  expect(() => loadConfig({ HARNESS_ORIGIN: "http://127.0.0.1:4100" })).toThrow();
});

test("bad port throws", () => {
  expect(() => loadConfig({ HARNESS_PORT: "nope" })).toThrow();
});

test("port 0 asks the OS for a free port, which main.ts re-reads after binding", () => {
  expect(loadConfig({ HARNESS_PORT: "0" }).port).toBe(0);
  expect(() => loadConfig({ HARNESS_PORT: "65536" })).toThrow();
});

test("HARNESS_TRUST_PROXY defaults to false and accepts true", () => {
  expect(loadConfig({}).trustProxy).toBe(false);
  expect(loadConfig({ HARNESS_TRUST_PROXY: "true" }).trustProxy).toBe(true);
  expect(() => loadConfig({ HARNESS_TRUST_PROXY: "maybe" })).toThrow();
});

function homeWith(tunnel: string): string {
  const home = mkdtempSync(join(tmpdir(), "harness-config-"));
  writeFileSync(join(home, "tunnel.json"), tunnel);
  return home;
}

test("tunnel.json supplies the origin and rp id when HARNESS_ORIGIN is unset", () => {
  const home = homeWith('{"provider":"tailscale-serve","origin":"https://mac.tail1234.ts.net"}');
  expect(loadConfig({ HARNESS_HOME: home }).rp).toEqual({
    id: "mac.tail1234.ts.net",
    name: "Harness",
    origin: "https://mac.tail1234.ts.net",
  });
});

test("HARNESS_ORIGIN wins over tunnel.json", () => {
  const home = homeWith('{"provider":"tailscale-serve","origin":"https://mac.tail1234.ts.net"}');
  expect(
    loadConfig({ HARNESS_HOME: home, HARNESS_ORIGIN: "http://localhost:4100" }).rp.origin,
  ).toBe("http://localhost:4100");
});

test("a tunnel.json origin that is http on a non-localhost host is ignored with a warning", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const home = homeWith('{"provider":"cloudflare","origin":"http://evil.example.com"}');
  expect(loadConfig({ HARNESS_HOME: home, HARNESS_PORT: "4100" }).rp.origin).toBe(
    "http://localhost:4100",
  );
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

test("a malformed tunnel.json is ignored with a warning, never a crash", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  for (const text of ["{not json", '{"provider":"ngrok"}', "[]"]) {
    const home = homeWith(text);
    expect(loadConfig({ HARNESS_HOME: home, HARNESS_PORT: "4100" }).rp.origin).toBe(
      "http://localhost:4100",
    );
  }
  expect(warn).toHaveBeenCalledTimes(3);
  warn.mockRestore();
});

test("a tunnel.json without an origin falls back to localhost", () => {
  const home = homeWith('{"provider":"cloudflare"}');
  expect(loadConfig({ HARNESS_HOME: home, HARNESS_PORT: "4100" }).rp.origin).toBe(
    "http://localhost:4100",
  );
});
