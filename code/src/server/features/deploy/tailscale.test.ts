import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { discoverTailscale } from "./tailscale";

const FAKE_BIN = join(import.meta.dir, "../../test-support/fake-bin-dist");

afterEach(() => {
  delete process.env.FAKE_TAILSCALE_RAW;
});

test("peers map to name, DNS name, OS and online, skipping peers without DNS", async () => {
  expect(await discoverTailscale(FAKE_BIN)).toEqual([
    { name: "nas", dnsName: "nas.tail1234.ts.net", os: "linux", online: true },
    { name: "laptop", dnsName: "laptop.tail1234.ts.net", os: "macOS", online: false },
  ]);
});

test("malformed or unexpected JSON gives an empty list", async () => {
  for (const raw of ["not json {", "[]", '{"Peer":"nope"}']) {
    process.env.FAKE_TAILSCALE_RAW = raw;
    expect(await discoverTailscale(FAKE_BIN)).toEqual([]);
  }
});

test("an absent binary gives an empty list", async () => {
  expect(await discoverTailscale(join(import.meta.dir, "no-such-bin"))).toEqual([]);
});
