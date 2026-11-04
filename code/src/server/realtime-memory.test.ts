import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WsMessage, wsMessageSchema } from "../shared/realtime";
import { migrate, openDb } from "./db/db";
import { migrations } from "./db/migrations";
import { drainCommits } from "./features/memory/git-log";
import { createOrg } from "./features/orgs/api";
import { createApp } from "./http";
import { wireRealtime } from "./realtime";
import { listenDeferred, openSocket, sessionHeaders, until } from "./test-support/app-kit";

const stops: (() => void)[] = [];
let home = "";
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await drainCommits();
  rmSync(home, { recursive: true, force: true });
});

test("a note write nudges the org topic, and the nudge fits the socket schema", async () => {
  home = mkdtempSync(join(tmpdir(), "harness-rt-memory-"));
  const db = openDb(":memory:");
  migrate(db, migrations);
  const { server, port, attach } = listenDeferred();
  const origin = `http://localhost:${port}`;
  attach(
    createApp({
      db,
      home,
      port,
      rp: { id: "localhost", name: "Harness", origin },
      instanceId: "i",
      version: "1",
    }),
  );
  stops.push(wireRealtime(db, server), () => void server.stop(true));
  const alice = await sessionHeaders(db, { origin });
  const org = createOrg(db, {
    name: "acme",
    slug: "acme",
    ownerUserId: alice.userId,
    ownerName: "acme",
    ownerHandle: "acme",
  });
  const ws = await openSocket(`ws://127.0.0.1:${port}/ws?topic=org:${org.id}`, alice.headers);
  stops.push(() => ws.close());
  const seen: WsMessage[] = [];
  ws.onmessage = (e) => seen.push(wsMessageSchema.parse(JSON.parse(String(e.data))));
  const res = await fetch(`http://127.0.0.1:${port}/api/orgs/acme/memory/notes`, {
    method: "POST",
    headers: { ...alice.headers, host: `localhost:${port}` },
    body: JSON.stringify({ scope: "org", rel: "a.md", body: "# A\nhello", type: "fact" }),
  });
  expect(res.status).toBe(201);
  await until(() => seen.length > 0);
  expect(seen[0]).toEqual({ type: "memory", orgId: org.id });
});
