import { Database } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { build, hostTarget } from "../../../../scripts/build";
import { tempDir } from "../../test-support/selfupdate-kit";
import { getSecret } from "../agents/api";
import { type Kit, makeKit, post } from "./test-kit";

const BUILD_TIMEOUT_MS = 120_000;
let binaryDir = "";

// The compiled host binary is built once for the file; each test deploys a copy of it.
beforeAll(async () => {
  binaryDir = tempDir("deploy-build");
  await build({ target: hostTarget(), out: binaryDir, version: "9.9.9-deploy" });
}, BUILD_TIMEOUT_MS);

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const { port } = probe;
  await probe.stop(true);
  return port as number;
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const peerIds = (dbPath: string): string[] => {
  const db = new Database(dbPath, { readonly: true });
  const ids = db
    .query<{ id: string }, []>("SELECT id FROM peers")
    .all()
    .map((row) => row.id);
  db.close();
  return ids;
};

async function deployLocally(kit: Kit, port: number): Promise<{ status: string; result: unknown }> {
  const name = `harness-${hostTarget()}`;
  await Bun.write(join(kit.dist, name), Bun.file(join(binaryDir, name)));
  const api = kit.api();
  const created = await api.request("/requests", post({ targetId: "ssh:box", binary: name, port }));
  const { id } = (await created.json()) as { id: string };
  await api.request(`/requests/${id}/decide`, post({ decision: "approve" }));
  expect((await api.request(`/requests/${id}/run`, post({}))).status).toBe(202);
  let view = { status: "running", result: null as unknown };
  for (let i = 0; i < 400 && view.status === "running"; i++) {
    await Bun.sleep(150);
    view = (await (await api.request(`/requests/${id}`)).json()) as typeof view;
  }
  return view;
}

function noSecretCopied(kit: Kit, invite: string): void {
  const unit = kit.puts.find((put) => /\.(service|plist)$/.test(put.path));
  expect(unit?.text).toBeDefined();
  expect(unit?.text).not.toContain(invite);
  expect(unit?.text).not.toMatch(/token|secret/i);
  const ownKey = getSecret("federation.key", kit.home) ?? "";
  expect(ownKey.length).toBeGreaterThan(20);
  for (const file of files(kit.targetRoot)) {
    if (statSync(file).size < 10_000_000) expect(readFileSync(file).includes(ownKey)).toBe(false);
  }
}

test(
  "a local deploy ends healthy and done, with both instances paired and no secret copied",
  async () => {
    const port = await freePort();
    const kit = makeKit(`http://127.0.0.1:${await freePort()}`, 60_000);
    try {
      const view = await deployLocally(kit, port);
      expect(view).toMatchObject({ status: "done", result: { url: `http://localhost:${port}` } });
      const targetHome = join(kit.targetRoot, "home/deploy/.harness/home");
      const instanceId = (view.result as { instanceId: string }).instanceId;
      expect(peerIds(join(kit.home, "harness.db"))).toEqual([instanceId]);
      const own = (kit.db.query("SELECT id FROM instance").get() as { id: string }).id;
      expect(peerIds(join(targetHome, "harness.db"))).toEqual([own]);

      expect(files(targetHome)).not.toContain(join(targetHome, "pair-invite"));
      const invite = kit.puts.find((put) => put.path.endsWith("pair-invite"))?.text ?? "";
      const reuse = await fetch(`http://localhost:${port}/federation/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: invite,
          instanceId: "intruder",
          name: "intruder",
          url: "http://127.0.0.1:1",
          publicKey: generateKeyPairSync("ed25519")
            .publicKey.export({ format: "der", type: "spki" })
            .toString("base64"),
        }),
      });
      expect(reuse.status).toBe(403);
      noSecretCopied(kit, invite);
    } finally {
      kit.transport.stop();
    }
  },
  BUILD_TIMEOUT_MS,
);
