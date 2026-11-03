import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";

test("defaults expand ~ and use port 4100", () => {
  expect(loadConfig({})).toEqual({
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

test("port 0 is rejected because the host check needs the real port", () => {
  expect(() => loadConfig({ HARNESS_PORT: "0" })).toThrow();
});

test("HARNESS_TRUST_PROXY defaults to false and accepts true", () => {
  expect(loadConfig({}).trustProxy).toBe(false);
  expect(loadConfig({ HARNESS_TRUST_PROXY: "true" }).trustProxy).toBe(true);
  expect(() => loadConfig({ HARNESS_TRUST_PROXY: "maybe" })).toThrow();
});
