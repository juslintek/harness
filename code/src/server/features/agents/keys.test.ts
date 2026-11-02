import { expect, test } from "bun:test";
import { getKey, keyStatus, type SecuritySpawn, spawnBounded, storeKey } from "./keys";

const SECRET = "sk-test-0123456789abcdefghij";

function fakeSpawn(stored: Record<string, string> = {}): {
  spawn: SecuritySpawn;
  calls: Array<{ argv: string[]; stdin?: string }>;
} {
  const calls: Array<{ argv: string[]; stdin?: string }> = [];
  const spawn: SecuritySpawn = async (argv, stdin) => {
    calls.push(stdin === undefined ? { argv } : { argv, stdin });
    const provider = argv[argv.indexOf("-a") + 1] as string;
    if (argv[1] === "find-generic-password" && provider in stored)
      return { code: 0, stdout: `${stored[provider]}\n` };
    return { code: argv[1] === "find-generic-password" ? 44 : 0, stdout: "" };
  };
  return { spawn, calls };
}

test("keyStatus reports the source and never the value", async () => {
  const { spawn } = fakeSpawn({ gemini: SECRET });
  const status = await keyStatus(spawn, { OPENAI_API_KEY: SECRET });
  expect(status).toEqual([
    { provider: "anthropic", source: null },
    { provider: "openai", source: "env" },
    { provider: "gemini", source: "keychain" },
    { provider: "openrouter", source: null },
  ]);
  expect(JSON.stringify(status)).not.toContain(SECRET);
});

test("getKey prefers env and falls back to the keychain", async () => {
  const { spawn, calls } = fakeSpawn({ openai: "from-keychain" });
  expect(await getKey("openai", spawn, { OPENAI_API_KEY: "from-env" })).toBe("from-env");
  expect(calls).toHaveLength(0);
  expect(await getKey("openai", spawn, {})).toBe("from-keychain");
  expect(await getKey("anthropic", spawn, {})).toBeNull();
});

test("storeKey sends the command on stdin and keeps the key out of argv", async () => {
  const { spawn, calls } = fakeSpawn();
  await storeKey("openai", SECRET, spawn);
  expect(calls[0]?.argv).toEqual(["security", "-i"]);
  expect(calls[0]?.argv.join(" ")).not.toContain(SECRET);
  expect(calls[0]?.stdin).toBe(`add-generic-password -U -s harness -a openai -w "${SECRET}"\n`);
});

test("storeKey escapes quotes and backslashes and rejects newlines", async () => {
  const { spawn, calls } = fakeSpawn();
  await storeKey("openai", 'a"b\\c-0123456789012345', spawn);
  expect(calls[0]?.stdin).toContain('-w "a\\"b\\\\c-0123456789012345"');
  await expect(storeKey("openai", "line1\nadd-generic-password", spawn)).rejects.toThrow();
});

test("spawnBounded kills a process that never exits and reports a timeout", async () => {
  const started = Date.now();
  expect(await spawnBounded(["sleep", "30"], undefined, 100)).toEqual({ code: 124, stdout: "" });
  expect(Date.now() - started).toBeLessThan(2000);
});

test("spawnBounded treats a missing binary as not found", async () => {
  expect((await spawnBounded(["harness-no-such-binary-xyz"])).code).toBe(127);
});
