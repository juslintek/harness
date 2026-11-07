import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSecret, getSecret, secretNames, setSecret } from "./api";
import { backup } from "./secrets-file";

backup.exclude = async () => undefined;

const freshHome = (): string => mkdtempSync(join(tmpdir(), "harness-secrets-"));

test("set, get and delete round trip", () => {
  const home = freshHome();
  expect(getSecret("smtp.password", home)).toBeUndefined();
  setSecret("smtp.password", "hunter2", home);
  expect(getSecret("smtp.password", home)).toBe("hunter2");
  deleteSecret("smtp.password", home);
  expect(getSecret("smtp.password", home)).toBeUndefined();
  deleteSecret("smtp.password", home);
});

test("file is 0600 and the directory 0700", () => {
  const home = freshHome();
  setSecret("a", "1", home);
  expect(statSync(join(home, "secrets.json")).mode & 0o777).toBe(0o600);
  expect(statSync(home).mode & 0o777).toBe(0o700);
});

test("large values survive the atomic write", () => {
  const home = freshHome();
  const secret = "x".repeat(1024 * 1024);
  setSecret("smtp.password", secret, home);
  expect(getSecret("smtp.password", home)).toBe(secret);
});

test("deleting a secret reapplies the backup exclusion", () => {
  const home = freshHome();
  const excluded: string[] = [];
  const original = backup.exclude;
  backup.exclude = async (file) => {
    excluded.push(file);
  };
  try {
    setSecret("smtp.password", "one", home);
    deleteSecret("smtp.password", home);
  } finally {
    backup.exclude = original;
  }
  expect(excluded).toEqual([join(home, "secrets.json"), join(home, "secrets.json")]);
});

test("two names do not clobber each other", () => {
  const home = freshHome();
  setSecret("one", "1", home);
  setSecret("two", "2", home);
  expect(getSecret("one", home)).toBe("1");
  expect(getSecret("two", home)).toBe("2");
});

test("provider keys and unknown names already in the file survive a write and a delete", () => {
  const home = freshHome();
  Bun.write(join(home, "secrets.json"), JSON.stringify({ openai: "sk-x", "Odd Name": "kept" }));
  setSecret("slack.token", "xoxb", home);
  deleteSecret("slack.token", home);
  expect(JSON.parse(readFileSync(join(home, "secrets.json"), "utf8"))).toEqual({
    openai: "sk-x",
    "Odd Name": "kept",
  });
});

test("names outside [a-z0-9._-]{1,64} throw", () => {
  const home = freshHome();
  for (const bad of ["../x", "", "UPPER", "a b", "a".repeat(65)]) {
    expect(() => setSecret(bad, "v", home)).toThrow("secret name");
    expect(() => getSecret(bad, home)).toThrow("secret name");
    expect(() => deleteSecret(bad, home)).toThrow("secret name");
  }
});

test("secretNames lists names only", () => {
  const home = freshHome();
  setSecret("b", "value-b", home);
  setSecret("a", "value-a", home);
  expect(secretNames(home)).toEqual(["a", "b"]);
});
