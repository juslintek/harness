import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, getKey, storeKey } from "./keys";

const SECRET = "sk-test-0123456789abcdefghij";
const freshHome = (): string => mkdtempSync(join(tmpdir(), "harness-keys-"));
const excluded: string[] = [];
backup.exclude = async (file) => {
  excluded.push(file);
};

test("every write excludes the store from Time Machine and a failing tmutil does not fail the write", async () => {
  const home = freshHome();
  excluded.length = 0;
  await storeKey("openai", SECRET, home);
  expect(excluded).toEqual([join(home, "secrets.json")]);
  const original = backup.exclude;
  backup.exclude = () => Promise.reject(new Error("no tmutil"));
  const log = console.error;
  console.error = () => undefined;
  try {
    await storeKey("gemini", "second-key-0123456789", home);
  } finally {
    console.error = log;
    backup.exclude = original;
  }
  expect(JSON.parse(readFileSync(join(home, "secrets.json"), "utf8"))).toHaveProperty("gemini");
});

test("a malformed store never puts its content into the error", async () => {
  const leak = "AIzaSyD0123456789abcdefXYZ";
  const home = freshHome();
  await Bun.write(join(home, "secrets.json"), `{"gemini":${leak}}`);
  const message = await getKey("gemini", async () => ({ code: 44, stdout: "" }), {}, home).then(
    () => "",
    (e: Error) => `${e.message} ${String(e.cause ?? "")}`,
  );
  expect(message).toContain("is not valid JSON");
  expect(message).not.toContain(leak);
  await Bun.write(join(home, "secrets.json"), `{"gemini":["${leak}"]}`);
  const shape = await storeKey("openai", SECRET, home).then(
    () => "",
    (e: Error) => `${e.message} ${String(e.cause ?? "")}`,
  );
  expect(shape).toContain("has an unexpected shape");
  expect(shape).not.toContain(leak);
});
