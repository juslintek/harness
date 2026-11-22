import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildSrtSettings } from "./sandbox";
import {
  accountsRoot,
  CLAUDE_DENY_WRITE,
  CODEX_DENY_WRITE,
  homeDenyWrite,
  validateAccountHome,
} from "./sandbox-accounts";
import { baseInput } from "./sandbox-kit";

test("non-default claude run isolates account A and hides default credentials and config", () => {
  const uid = process.getuid?.();
  const s = buildSrtSettings({ ...baseInput, account: { home: "/hh/accounts/a" } });
  expect(s.filesystem.allowRead).toContain("/hh/accounts/a");
  expect(s.filesystem.allowWrite).toContain("/hh/accounts/a");
  expect(s.filesystem.denyRead).toEqual(
    expect.arrayContaining([
      "/hh/accounts",
      join(homedir(), ".claude/.credentials.json"),
      join(homedir(), ".codex/auth.json"),
    ]),
  );
  expect(s.filesystem.allowWrite).not.toContain(join(homedir(), ".claude"));
  expect(s.filesystem.allowWrite).toEqual(
    expect.arrayContaining([`/private/tmp/claude-${uid}`, "/private/tmp/claude-*-cwd"]),
  );
  expect(s.filesystem.denyWrite).toEqual(
    expect.arrayContaining([
      "/hh/accounts/a/settings.json",
      "/hh/accounts/a/hooks",
      "/hh/accounts/a/plugins",
      "/hh/accounts/a/commands",
      "/hh/accounts/a/skills",
      "/hh/accounts/a/config.toml",
      ...homeDenyWrite("/hh/accounts/a"),
    ]),
  );
  expect(homeDenyWrite("/hh/accounts/a")).toEqual(
    [...new Set([...CLAUDE_DENY_WRITE, ...CODEX_DENY_WRITE])].map((n) => join("/hh/accounts/a", n)),
  );
});

test("default account run keeps own config writable and own credentials readable", () => {
  for (const account of [undefined, null, { home: null }] as const) {
    const s = buildSrtSettings({ ...baseInput, account });
    expect(s.filesystem.denyRead).toContain("/hh/accounts");
    expect(s.filesystem.denyRead).not.toContain(join(homedir(), ".claude/.credentials.json"));
    expect((s.filesystem.allowRead ?? []).some((p) => String(p).startsWith("/hh/accounts"))).toBe(
      false,
    );
    expect(s.filesystem.allowWrite.some((p) => String(p).startsWith("/hh/accounts"))).toBe(false);
    expect(s.filesystem.allowWrite).toContain(join(homedir(), ".claude"));
  }
});

test("non-default codex run denies all default credentials and keeps accounts out of allow lists", () => {
  const s = buildSrtSettings({
    ...baseInput,
    agentId: "codex",
    agentStateWrite: [],
    codexHome: "/runs/r1/codex-home",
    account: { home: "/hh/accounts/b" },
  });
  expect(s.filesystem.denyRead).toEqual(
    expect.arrayContaining([
      "/hh/accounts",
      join(homedir(), ".codex/auth.json"),
      join(homedir(), ".claude/.credentials.json"),
    ]),
  );
  expect(s.filesystem.allowRead).not.toContain("/hh/accounts/b");
  expect(s.filesystem.allowWrite).not.toContain("/hh/accounts/b");
  expect(s.filesystem.allowWrite).toContain("/runs/r1/codex-home");
});

function assertAllowWriteImpliesAllowRead(
  root: string,
  account: undefined | null | { home: string | null },
  agentId: "claude" | "codex",
  codexHome: string | null,
) {
  for (const readOnlyWorktree of [false, true]) {
    for (const preset of ["offline", "dev", "open-web"] as const) {
      const s = buildSrtSettings({
        ...baseInput,
        account,
        agentId,
        codexHome,
        readOnlyWorktree,
        preset,
        agentStateWrite: agentId === "claude" ? baseInput.agentStateWrite : [],
      });
      const underAccounts = s.filesystem.allowWrite.filter(
        (w) => w === root || String(w).startsWith(`${root}/`),
      );
      expect(s.filesystem.allowRead).toEqual(expect.arrayContaining(underAccounts));
    }
  }
}

test("invariant: any allowWrite inside accountsRoot is always present in allowRead", () => {
  const root = accountsRoot(baseInput.harnessHome);
  for (const account of [undefined, null, { home: null }, { home: "/hh/accounts/a" }] as const) {
    for (const agentId of ["claude", "codex"] as const) {
      for (const codexHome of [null, "/runs/r1/codex-home"] as const) {
        assertAllowWriteImpliesAllowRead(root, account, agentId, codexHome);
      }
    }
  }
});

test("validateAccountHome rejects relative, root, outside, and symlinked account homes", () => {
  for (const bad of [
    "accounts/a",
    "/hh/accounts",
    "/hh/accounts/.",
    "/hh/accounts/../other",
    "/hh/accounts-evil/a",
    "/tmp/other",
    join(homedir(), ".ssh"),
    "/hh/other",
    homedir(),
    "/hh",
  ]) {
    expect(() => validateAccountHome(bad, "/hh")).toThrow();
    expect(() => buildSrtSettings({ ...baseInput, account: { home: bad } })).toThrow();
  }

  const dir = mkdtempSync(join(tmpdir(), "sb-acct-"));
  try {
    const hh = join(dir, "hh");
    const accounts = join(hh, "accounts");
    const realSibling = join(accounts, "b");
    const outside = join(dir, "outside");
    mkdirSync(realSibling, { recursive: true });
    mkdirSync(outside, { recursive: true });

    const linkOutside = join(accounts, "link-out");
    symlinkSync(outside, linkOutside);
    expect(() => validateAccountHome(linkOutside, hh)).toThrow(/symlink/);

    const linkSibling = join(accounts, "link-sib");
    symlinkSync(realSibling, linkSibling);
    expect(() => validateAccountHome(linkSibling, hh)).toThrow(/symlink/);

    const valid = join(accounts, "a");
    mkdirSync(valid, { recursive: true });
    expect(validateAccountHome(valid, hh)).toBe(realpathSync(valid));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertSafe still rejects $HOME and harnessHome even with an account", () => {
  expect(() =>
    buildSrtSettings({ ...baseInput, account: { home: "/hh/accounts/a" }, agentStateWrite: ["~"] }),
  ).toThrow(/home/);
  expect(() =>
    buildSrtSettings({
      ...baseInput,
      account: { home: "/hh/accounts/a" },
      agentStateWrite: ["/hh"],
    }),
  ).toThrow(/expose the harness home/);
});
