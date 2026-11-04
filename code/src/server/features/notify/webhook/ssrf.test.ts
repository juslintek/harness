import { expect, test } from "bun:test";
import { isBlockedIp, webhookUrlProblem } from "./ssrf";

test("loopback, link-local, private and unique-local addresses are blocked", () => {
  for (const ip of [
    "127.0.0.1",
    "127.8.8.8",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a00:5",
  ]) {
    expect(isBlockedIp(ip)).toBe(true);
  }
});

test("public addresses pass", () => {
  for (const ip of ["93.184.216.34", "172.32.0.1", "172.15.0.1", "8.8.8.8", "2606:4700::1111"]) {
    expect(isBlockedIp(ip)).toBe(false);
  }
});

test("literal private urls are refused without a lookup", async () => {
  expect(await webhookUrlProblem("https://169.254.169.254/")).not.toBeNull();
  expect(await webhookUrlProblem("https://10.0.0.5/")).not.toBeNull();
  expect(await webhookUrlProblem("https://[::1]/")).not.toBeNull();
  expect(await webhookUrlProblem("https://[::ffff:127.0.0.1]/")).not.toBeNull();
  expect(await webhookUrlProblem("https://2130706433/")).not.toBeNull();
});

test("only https is accepted, plain http only for localhost under test", async () => {
  expect(await webhookUrlProblem("http://example.com/")).not.toBeNull();
  expect(await webhookUrlProblem("ftp://example.com/")).not.toBeNull();
  expect(await webhookUrlProblem("not a url")).not.toBeNull();
  expect(await webhookUrlProblem("http://127.0.0.1:9/")).toBeNull();
  expect(await webhookUrlProblem("http://localhost:9/")).toBeNull();
  expect(await webhookUrlProblem("http://10.0.0.5/")).not.toBeNull();
  expect(await webhookUrlProblem("https://user:pw@example.com/")).not.toBeNull();
});

test("a name that resolves to a loopback address is refused", async () => {
  expect(await webhookUrlProblem("https://localhost/")).not.toBeNull();
});
