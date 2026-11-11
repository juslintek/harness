import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { targetViewSchema } from "../../../shared/distribution";
import { withActor } from "../../test-support/app-kit";
import { deployDiscoveryRoutes } from "./routes";

const FAKE_BIN = join(import.meta.dir, "../../test-support/fake-bin-dist");
const KEY_CONTENTS = "-----BEGIN PRIVATE KEY----- super-secret-key-material";

function fixture(): { sshConfigPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "harness-targets-"));
  writeFileSync(join(dir, "id_nas"), KEY_CONTENTS);
  writeFileSync(
    join(dir, "config"),
    `Host *\n  User root\nHost nas\n  HostName 10.0.0.5\n  User deploy\n  Port 2222\n  IdentityFile ${join(dir, "id_nas")}\n`,
  );
  return { sshConfigPath: join(dir, "config") };
}

test("an instance admin gets ssh, tailscale and docker targets without key contents", async () => {
  const app = withActor(deployDiscoveryRoutes({ ...fixture(), bin: FAKE_BIN }));
  const res = await app.request("/targets");
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain("super-secret-key-material");
  const targets = z.array(targetViewSchema).parse(JSON.parse(text));
  expect(targets.map((t) => t.id)).toEqual([
    "ssh:nas",
    "tailscale:nas.tail1234.ts.net",
    "tailscale:laptop.tail1234.ts.net",
    "docker:build-box",
  ]);
  expect(targets[0]).toMatchObject({ address: "10.0.0.5", user: "deploy", port: 2222 });
});

test("a missing ssh config and missing binaries give an empty list", async () => {
  const app = withActor(
    deployDiscoveryRoutes({
      sshConfigPath: join(tmpdir(), "no-such", "config"),
      bin: "/no/such/bin",
    }),
  );
  const res = await app.request("/targets");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);
});

test("a user who is not instance admin gets 403", async () => {
  const app = withActor(deployDiscoveryRoutes({ ...fixture(), bin: FAKE_BIN }), {
    instanceAdmin: false,
  });
  expect((await app.request("/targets")).status).toBe(403);
});
