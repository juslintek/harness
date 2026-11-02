import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";

test("defaults expand ~ and use port 4100", () => {
  expect(loadConfig({})).toEqual({
    home: join(homedir(), ".harness"),
    port: 4100,
    host: "127.0.0.1",
  });
});

test("env overrides", () => {
  expect(loadConfig({ HARNESS_HOME: "/x", HARNESS_PORT: "5000", HARNESS_HOST: "0.0.0.0" })).toEqual(
    {
      home: "/x",
      port: 5000,
      host: "0.0.0.0",
    },
  );
});

test("bad port throws", () => {
  expect(() => loadConfig({ HARNESS_PORT: "nope" })).toThrow();
});

test("port 0 is rejected because the host check needs the real port", () => {
  expect(() => loadConfig({ HARNESS_PORT: "0" })).toThrow();
});
