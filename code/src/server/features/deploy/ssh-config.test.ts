import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSsh } from "./ssh-config";

function sshDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-ssh-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

test("exact hosts are listed with HostName, User, Port and the IdentityFile path", () => {
  const dir = sshDir({
    config: `Host nas
  HostName 10.0.0.5
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_nas
  User ignored-second-value
`,
  });
  expect(discoverSsh(join(dir, "config"))).toEqual([
    {
      name: "nas",
      hostName: "10.0.0.5",
      user: "deploy",
      port: 2222,
      identityFile: "~/.ssh/id_nas",
    },
  ]);
});

test("wildcard, negated and Match entries are skipped, their options do not leak", () => {
  const dir = sshDir({
    config: `Host *
  User root
Host *.example.test web? !bad
  User root
Host mixed real
  HostName real.example.test
Match host foo
  User attacker
Host last
`,
  });
  const hosts = discoverSsh(join(dir, "config"));
  expect(hosts.map((h) => h.name)).toEqual(["mixed", "real", "last"]);
  expect(hosts.every((h) => h.user === undefined)).toBe(true);
});

test("Include is followed one level and only inside the ssh dir", () => {
  const outside = sshDir({ "evil.conf": "Host evil\n" });
  const dir = sshDir({
    config: `Include conf.d/*.conf
Include ${join(outside, "evil.conf")}
Host top
`,
    "conf.d/a.conf": "Host included\n  Include deeper.conf\n",
    "deeper.conf": "Host too-deep\n",
  });
  symlinkSync(join(outside, "evil.conf"), join(dir, "conf.d", "link.conf"));
  expect(
    discoverSsh(join(dir, "config"))
      .map((h) => h.name)
      .sort(),
  ).toEqual(["included", "top"]);
});

test("a missing file gives an empty list", () => {
  expect(discoverSsh(join(tmpdir(), "harness-no-such-dir", "config"))).toEqual([]);
});
