import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAdminSecret } from "./api";

test("secret file is 0600, 64 hex chars and stable across calls", () => {
  const home = mkdtempSync(join(tmpdir(), "harness-auth-"));
  const first = ensureAdminSecret(home);
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(statSync(join(home, "secret")).mode & 0o777).toBe(0o600);
  expect(ensureAdminSecret(home)).toBe(first);
});

test("empty or malformed secret files refuse to load and are left untouched", () => {
  for (const content of ["", "abc123", `${"g".repeat(64)}`]) {
    const home = mkdtempSync(join(tmpdir(), "harness-auth-"));
    writeFileSync(join(home, "secret"), content);
    expect(() => ensureAdminSecret(home)).toThrow(/not a 64-char hex secret/);
    expect(Bun.file(join(home, "secret")).size).toBe(content.length);
  }
});

test("creation leaves no temp file behind", () => {
  const home = mkdtempSync(join(tmpdir(), "harness-auth-"));
  ensureAdminSecret(home);
  expect(readdirSync(home)).toEqual(["secret"]);
});
