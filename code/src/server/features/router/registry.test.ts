import { expect, spyOn, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { estimateCostUsd, priceOf, refreshRegistry } from "./api";
import { listRegistry, registryStale } from "./registry";

const fixture = (): Promise<unknown> =>
  Bun.file(new URL("./fixtures/models-dev.json", import.meta.url)).json();

async function seeded() {
  const db = openDb(":memory:");
  migrate(db, migrations);
  await refreshRegistry(db, fixture);
  return db;
}

test("refreshRegistry with the fixture stores anthropic and openai models with prices", async () => {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const res = await refreshRegistry(db, fixture);
  expect(res.ok).toBe(true);
  expect(res.models).toBeGreaterThanOrEqual(6);
  const sonnet = listRegistry(db, "anthropic").find((m) => m.modelId === "claude-sonnet-4-5");
  expect(sonnet).toMatchObject({ inputUsdMtok: 3, outputUsdMtok: 15, cacheReadUsdMtok: 0.3 });
  expect(listRegistry(db, "openai").length).toBeGreaterThan(0);
});

test("refreshRegistry with a throwing fetch keeps the old rows and returns ok false", async () => {
  const db = await seeded();
  const before = listRegistry(db).length;
  const log = spyOn(console, "error").mockImplementation(() => {});
  const res = await refreshRegistry(db, () => Promise.reject(new Error("offline")));
  log.mockRestore();
  expect(res).toEqual({ ok: false, models: 0 });
  expect(listRegistry(db)).toHaveLength(before);
});

test("a feed with no priced models keeps the old rows", async () => {
  const db = await seeded();
  const before = listRegistry(db).length;
  const log = spyOn(console, "error").mockImplementation(() => {});
  const res = await refreshRegistry(db, async () => ({ x: { models: { m: { id: "m" } } } }));
  log.mockRestore();
  expect(res.ok).toBe(false);
  expect(listRegistry(db)).toHaveLength(before);
});

test("priceOf finds the anthropic row by exact id and by dated id; unknown is null", async () => {
  const db = await seeded();
  const exact = priceOf(db, { runtime: "claude", model: "claude-sonnet-4-5" });
  expect(exact).toEqual({ input: 3, output: 15, cacheRead: 0.3 });
  expect(priceOf(db, { runtime: "claude", model: "claude-sonnet-4-5-20250929" })).toEqual(exact);
  expect(priceOf(db, { runtime: "claude", model: "nonexistent" })).toBeNull();
  expect(priceOf(db, { runtime: "claude", model: null })).toBeNull();
  expect(priceOf(db, { runtime: "cursor", model: "claude-sonnet-4-5" })).toBeNull();
});

test("estimateCostUsd prices tokens per million", async () => {
  const db = await seeded();
  const tokens = { input: 1_000_000, output: 0, cacheRead: 0 };
  expect(estimateCostUsd(db, "claude", "claude-sonnet-4-5", tokens)).toBe(3);
  const mixed = { input: 0, output: 1_000_000, cacheRead: 1_000_000 };
  expect(estimateCostUsd(db, "claude", "claude-sonnet-4-5", mixed)).toBeCloseTo(15.3);
  expect(estimateCostUsd(db, "claude", "nonexistent", tokens)).toBeNull();
});

test("registryStale is true when empty or older than 24 hours", async () => {
  const empty = openDb(":memory:");
  migrate(empty, migrations);
  expect(registryStale(empty, Date.now())).toBe(true);
  const db = await seeded();
  expect(registryStale(db, Date.now())).toBe(false);
  expect(registryStale(db, Date.now() + 25 * 60 * 60 * 1000)).toBe(true);
});
