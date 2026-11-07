import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createApp } from "../../http";
import { listenDeferred } from "../../test-support/app-kit";
import { wireChat } from "../chat/api";
import { mintLocalLinkToken } from "../oauth/api";
import { createOrg } from "../orgs/api";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const undo of cleanups.splice(0)) await undo();
});

const SCRIPT = join(import.meta.dir, "../../../../scripts/mcp-stdio.ts");

// The real app is served on a real port and the proxy is a real child process, so the Host the
// script sends, the token handling and the SDK transports are all in play.
async function setup() {
  const home = mkdtempSync(join(tmpdir(), "mcp-stdio-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const db = openDb(":memory:");
  migrate(db, migrations);
  wireChat(db);
  const listener = listenDeferred();
  cleanups.push(() => listener.server.stop(true));
  const origin = `http://localhost:${listener.port}`;
  listener.attach(
    createApp({
      db,
      home,
      port: listener.port,
      rp: { id: "localhost", name: "Harness", origin },
      instanceId: "i",
      version: "1",
    }),
  );
  const userId = Bun.randomUUIDv7();
  db.query(
    "INSERT INTO users (id, email, name, instance_admin, created_at) VALUES (?, ?, 'T', 1, ?)",
  ).run(userId, "t@example.test", Date.now());
  const org = createOrg(db, {
    name: "acme",
    slug: "acme",
    ownerUserId: userId,
    ownerName: "a",
    ownerHandle: "own",
  });
  const member = db
    .query<{ id: string }, [string]>("SELECT id FROM members WHERE org_id = ?")
    .get(org.id);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "secrets.json"),
    JSON.stringify({ "desktop.token": mintLocalLinkToken(db, member?.id as string, org.id) }),
  );
  return { home, port: listener.port };
}

test("the stdio proxy uses its saved loopback port despite a public configured origin", async () => {
  const { home, port } = await setup();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SCRIPT, "--home", home, "--port", String(port)],
    env: { PATH: process.env.PATH ?? "", HARNESS_ORIGIN: "https://public.example" },
  });
  const client = new Client({ name: "desktop", version: "0" });
  cleanups.push(() => client.close());
  await client.connect(transport);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(names).toContain("board_list");
  expect(names).toContain("chat_post");
});
