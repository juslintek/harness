import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getKey,
  keyStatus,
  migrateLegacy,
  type SecuritySpawn,
  spawnBounded,
  storeKey,
} from "./keys";

const SECRET = "sk-test-0123456789abcdefghij";

const freshHome = (): string => mkdtempSync(join(tmpdir(), "harness-keys-"));

// Stands in for the login Keychain: `stored` are the old items, deletes are recorded.
function fakeSpawn(stored: Record<string, string> = {}): {
  spawn: SecuritySpawn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const spawn: SecuritySpawn = async (argv) => {
    calls.push(argv);
    const provider = argv[argv.indexOf("-a") + 1] as string;
    if (argv[1] === "find-generic-password" && provider in stored)
      return { code: 0, stdout: `${stored[provider]}\n` };
    if (argv[1] === "delete-generic-password") {
      delete stored[provider];
      return { code: 0, stdout: "" };
    }
    return { code: 44, stdout: "" };
  };
  return { spawn, calls };
}

test("keyStatus reports the source and never the value", async () => {
  const home = freshHome();
  await storeKey("gemini", SECRET, home);
  const status = await keyStatus(fakeSpawn().spawn, { OPENAI_API_KEY: SECRET }, home);
  expect(status).toEqual([
    { provider: "anthropic", source: null },
    { provider: "openai", source: "env" },
    { provider: "gemini", source: "keychain" },
    { provider: "openrouter", source: null },
  ]);
  expect(JSON.stringify(status)).not.toContain(SECRET);
});

test("getKey prefers env and falls back to the store", async () => {
  const home = freshHome();
  const { spawn } = fakeSpawn();
  await storeKey("openai", "from-store", home);
  expect(await getKey("openai", spawn, { OPENAI_API_KEY: "from-env" }, home)).toBe("from-env");
  expect(await getKey("openai", spawn, {}, home)).toBe("from-store");
  expect(await getKey("anthropic", spawn, {}, home)).toBeNull();
});

test("the store is a 0600 file under the harness home and keeps other keys on update", async () => {
  const home = freshHome();
  await storeKey("openai", SECRET, home);
  await storeKey("gemini", "second-key-0123456789", home);
  expect(statSync(join(home, "secrets.json")).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(join(home, "secrets.json"), "utf8"))).toEqual({
    openai: SECRET,
    gemini: "second-key-0123456789",
  });
});

test("concurrent stores do not drop each other's key", async () => {
  const home = freshHome();
  await Promise.all([
    storeKey("openai", "key-one-0123456789", home),
    storeKey("gemini", "key-two-0123456789", home),
  ]);
  expect(Object.keys(JSON.parse(readFileSync(join(home, "secrets.json"), "utf8"))).sort()).toEqual([
    "gemini",
    "openai",
  ]);
});

test("storeKey rejects control characters and other non-printables", async () => {
  const home = freshHome();
  for (const bad of ["line1\nline2", "tab\there", "nul\u0000byte", "bell\u0007", "zw​space"])
    await expect(storeKey("openai", bad, home)).rejects.toThrow("printable");
});

test("old login Keychain items move into the store and are deleted after the copy reads back", async () => {
  const home = freshHome();
  const { spawn, calls } = fakeSpawn({ openai: "legacy-openai-0123456789" });
  expect(await getKey("openai", spawn, {}, home)).toBe("legacy-openai-0123456789");
  expect(JSON.parse(readFileSync(join(home, "secrets.json"), "utf8"))).toEqual({
    openai: "legacy-openai-0123456789",
  });
  expect(calls).toContainEqual([
    "security",
    "delete-generic-password",
    "-s",
    "harness",
    "-a",
    "openai",
  ]);
  expect(calls.filter((c) => c[1] === "delete-generic-password")).toHaveLength(1);
});

test("migration never overwrites a key already in the store and leaves the old item alone", async () => {
  const home = freshHome();
  await storeKey("openai", "new-store-key-0123456789", home);
  const { spawn, calls } = fakeSpawn({ openai: "legacy-openai-0123456789" });
  expect(await getKey("openai", spawn, {}, home)).toBe("new-store-key-0123456789");
  expect(calls.filter((c) => c[1] === "delete-generic-password")).toHaveLength(0);
});

const deletes = (calls: string[][]): number =>
  calls.filter((c) => c[1] === "delete-generic-password").length;

test("a copy that does not read back keeps the Keychain item", async () => {
  const home = freshHome();
  const { spawn, calls } = fakeSpawn({ openai: "legacy-openai-0123456789" });
  const wrong = (h: string, provider: string) =>
    storeKey(provider as "openai", "something-else-0123456789", h);
  await expect(migrateLegacy(home, spawn, wrong)).rejects.toThrow("could not migrate");
  expect(deletes(calls)).toBe(0);
});

test("a failed store write keeps the Keychain item", async () => {
  const home = freshHome();
  const { spawn, calls } = fakeSpawn({ openai: "legacy-openai-0123456789" });
  const failing = () => Promise.reject(new Error("disk full"));
  await expect(migrateLegacy(home, spawn, failing)).rejects.toThrow("disk full");
  expect(deletes(calls)).toBe(0);
});

test("a failed Keychain delete keeps the key in the store", async () => {
  const home = freshHome();
  const { spawn } = fakeSpawn({ openai: "legacy-openai-0123456789" });
  const brokenDelete: SecuritySpawn = (argv, stdin) =>
    argv[1] === "delete-generic-password"
      ? Promise.reject(new Error("locked"))
      : spawn(argv, stdin);
  await migrateLegacy(home, brokenDelete);
  expect(JSON.parse(readFileSync(join(home, "secrets.json"), "utf8"))).toEqual({
    openai: "legacy-openai-0123456789",
  });
});

test("an unreadable store fails loudly and is not overwritten", async () => {
  const home = freshHome();
  await Bun.write(join(home, "secrets.json"), "{not json");
  await expect(storeKey("openai", SECRET, home)).rejects.toThrow();
  expect(readFileSync(join(home, "secrets.json"), "utf8")).toBe("{not json");
});

test("an existing home directory is tightened to 0700 and no temp file is left", async () => {
  const home = freshHome();
  chmodSync(home, 0o755);
  await storeKey("openai", SECRET, home);
  expect(statSync(home).mode & 0o777).toBe(0o700);
  expect(readdirSync(home)).toEqual(["secrets.json"]);
});

test("spawnBounded kills a process that never exits and reports a timeout", async () => {
  const started = Date.now();
  expect(await spawnBounded(["sleep", "30"], undefined, 100)).toEqual({ code: 124, stdout: "" });
  expect(Date.now() - started).toBeLessThan(2000);
});

test("spawnBounded treats a missing binary as not found", async () => {
  expect((await spawnBounded(["harness-no-such-binary-xyz"])).code).toBe(127);
});
