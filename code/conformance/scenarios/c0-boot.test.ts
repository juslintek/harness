import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { healthSchema } from "../../src/shared/health";
import { api, until } from "../kit/client";
import { latestMigration } from "../kit/seed";
import { lazyBoot } from "../kit/server";

const lazy = lazyBoot({});
afterAll(() => lazy.stop());

test("C0-health [phase:0] [slice:http] [focus:1]", async () => {
  const server = await lazy.get();
  const res = await api(server).call("GET", "/api/health");
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  const health = healthSchema.parse(body);
  expect(Object.keys(body as object).sort()).toEqual(["instanceId", "ok", "version"]);
  expect(health.instanceId).toMatch(/^[0-9a-f-]{36}$/);
  // Agents and local probes reach health by the loopback address, which the browser guard refuses elsewhere.
  const probe = await fetch(`${server.base}/api/health`);
  expect(probe.status).toBe(200);
});

test("C0-schema-parity [phase:0] [slice:db] [focus:1]", async () => {
  const server = await lazy.get();
  const db = new Database(join(server.home, "harness.db"), { readonly: true });
  try {
    const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    expect(row?.user_version).toBe(latestMigration());
  } finally {
    db.close();
  }
});

test("C0-stdout [phase:0] [slice:stdout] [focus:1]", async () => {
  const server = await lazy.get();
  await until(
    () => /first-run enrollment: .*\n$/.test(server.stdout()),
    "the first-run enrollment line",
  );
  const lines = server.stdout().split("\n");
  expect(lines[0]).toBe(`harness listening on http://127.0.0.1:${server.port}/`);
  const code = "[a-z2-7]{4}(?:-[a-z2-7]{4}){3}";
  expect(lines[1]).toMatch(new RegExp(`^first-run enrollment: ${server.origin}/#/enroll/${code}$`));
  expect(lines[2]).toBe("");
});
