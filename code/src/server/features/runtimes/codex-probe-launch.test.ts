import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fakeCliSpec } from "../../test-support/agents-kit";
import { FAKE_CODEX_APP_SERVER } from "../../test-support/fake-codex-app-server";
import { accountQuota, type CodexProbeLauncher, probeAccountQuota } from "../usage/api";
import { createCodexProbeLaunch } from "./api";
import { createProbeLaunch } from "./launch";
import { addAccount, cleanup, fakeDeps, fixture, makeDir } from "./manager-kit";

afterAll(cleanup);

function assertCodexProbeSrt(rawSrt: string, harnessHome: string): void {
  const srt = JSON.parse(rawSrt) as {
    network: { allowedDomains: string[] };
    enableWeakerNetworkIsolation: boolean;
    filesystem: { denyRead: string[] };
  };
  expect(srt.network.allowedDomains).toEqual(["chatgpt.com"]);
  expect(srt.network.allowedDomains).not.toContain("github.com");
  expect(srt.enableWeakerNetworkIsolation).toBe(true);
  expect(srt.filesystem.denyRead).toEqual(
    expect.arrayContaining([
      join(homedir(), ".codex/auth.json"),
      realpathSync(join(harnessHome, "accounts")),
    ]),
  );
}

test("createCodexProbeLaunch isolates srt to chatgpt.com and writes back refreshed auth per account", async () => {
  const f = fixture();
  const homeA = join(f.home, "accounts", "a");
  const homeB = join(f.home, "accounts", "b");
  mkdirSync(homeA, { recursive: true });
  mkdirSync(homeB, { recursive: true });
  writeFileSync(
    join(homeA, "auth.json"),
    JSON.stringify({ account: "a@example.test", usedPercent: 18, mode: "refresh" }),
  );
  writeFileSync(
    join(homeB, "auth.json"),
    JSON.stringify({ account: "b@example.test", usedPercent: 64 }),
  );

  const idA = addAccount(f.db, "codex", homeA, "active");
  const idB = addAccount(f.db, "codex", homeB, "active");
  const spec = fakeCliSpec("codex");
  const deps = fakeDeps(f, []);
  const srtFiles: string[] = [];

  const launch: CodexProbeLauncher = async (dir, account) => {
    const handle = await createCodexProbeLaunch(deps, dir, account, {
      command: [process.execPath, FAKE_CODEX_APP_SERVER],
      spec,
    });
    srtFiles.push(readFileSync(join(dir, "srt.json"), "utf8"));
    return handle;
  };

  expect((await probeAccountQuota(f.db, idA, { home: f.home, launch })).status).toBe("ok");
  expect((await probeAccountQuota(f.db, idB, { home: f.home, launch })).status).toBe("ok");
  expect(accountQuota(f.db, idA).find((q) => q.window === "primary")?.usedPercent).toBe(18);
  expect(accountQuota(f.db, idB).find((q) => q.window === "primary")?.usedPercent).toBe(64);
  expect(JSON.parse(readFileSync(join(homeA, "auth.json"), "utf8"))).toMatchObject({
    account: "a@example.test",
    refreshed: true,
  });
  expect(JSON.parse(readFileSync(join(homeB, "auth.json"), "utf8"))).toEqual({
    account: "b@example.test",
    usedPercent: 64,
  });
  assertCodexProbeSrt(srtFiles[0] ?? "{}", f.home);
});

test("createProbeLaunch calls codex.finish() to drop token copy if writeSrtSettings throws", async () => {
  const f = fixture();
  const homeA = join(f.home, "accounts", "a");
  mkdirSync(homeA, { recursive: true });
  writeFileSync(join(homeA, "auth.json"), JSON.stringify({ who: "a" }));
  const idA = addAccount(f.db, "codex", homeA, "active");
  const badSpec = { ...fakeCliSpec("codex"), stateWrite: ["~"] };
  const probeDir = join(makeDir(), "probe");

  await expect(
    createProbeLaunch(fakeDeps(f, []), badSpec, probeDir, { id: idA, home: homeA }),
  ).rejects.toThrow(/home directory/);
  expect(existsSync(join(probeDir, "codex-auth.base"))).toBe(false);
});
