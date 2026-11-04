import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildContract, CONTRACT_DIR } from "./contract-dump";

test("contract/ is up to date; run `bun run contract:dump` after changing routes, schemas or tools", async () => {
  const built = await buildContract();
  for (const [path, content] of Object.entries(built)) {
    expect(readFileSync(join(CONTRACT_DIR, path), "utf8")).toBe(content);
  }
  const committed = readdirSync(join(CONTRACT_DIR, "schemas")).map((name) => `schemas/${name}`);
  expect(committed.sort()).toEqual(
    Object.keys(built)
      .filter((p) => p.startsWith("schemas/"))
      .sort(),
  );
});

test("two builds produce identical bytes", async () => {
  expect(await buildContract()).toEqual(await buildContract());
});

test("a path described in routes-extra.json is not also in routes.json", async () => {
  const built = await buildContract();
  const main = JSON.parse(built["routes.json"] as string) as { method: string; path: string }[];
  const extra = JSON.parse(built["routes-extra.json"] as string) as { path: string }[];
  const described = new Set(extra.map((entry) => entry.path));
  expect(main.filter((entry) => described.has(entry.path))).toEqual([]);
  expect(main.some((entry) => entry.path === "/api/orgs")).toBe(true);
});
