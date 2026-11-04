import { afterAll, expect, test } from "bun:test";
import { zstdCompressSync } from "node:zlib";
import { api } from "../kit/client";
import { type SeededSession, seedSession } from "../kit/seed";
import { lazyBoot } from "../kit/server";

const PAD = "padding ".repeat(20);
const LONG = `${PAD}the Deploy failed on host seven ${"tail ".repeat(20)}`;
const SEALED = ["first sealed body", "second sealed body with ąčę and 🙂 inside"];
const sessions = {} as Record<"admin" | "member", SeededSession>;

// Events are written the way the logs repo leaves them: base row, then the pending body and the
// two text indexes. The sealed pair lives in a zstd segment instead of pending_payloads.
function seedEvents(db: import("bun:sqlite").Database): void {
  const insert = db.query(
    "INSERT INTO events (rowid, id, ts, run_id, kind, command, segment_id, seg_offset, seg_len) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const pending = (rowid: number, runId: string | null, body: string): void => {
    db.query("INSERT INTO pending_payloads (event_rowid, run_id, body) VALUES (?, ?, ?)").run(
      rowid,
      runId,
      body,
    );
    db.query("INSERT INTO events_fts (rowid, body) VALUES (?, ?)").run(rowid, body);
  };
  insert.run(1, "ev-long", 1000, "run-a", "message", null, null, null, null);
  pending(1, "run-a", LONG);
  insert.run(2, "ev-cmd", 2000, null, "tool_call", "git push origin main", null, null, null);
  db.query("INSERT INTO commands_fts (rowid, text) VALUES (?, ?)").run(2, "git push origin main");

  const parts = SEALED.map((body) => Buffer.from(body, "utf8"));
  const raw = Buffer.concat(parts);
  db.query(
    "INSERT INTO segments (id, run_id, created_at, level, raw_len, bytes) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("seg-1", "run-b", 1, 3, raw.length, zstdCompressSync(raw));
  let offset = 0;
  SEALED.forEach((body, i) => {
    const len = parts[i]?.length ?? 0;
    insert.run(10 + i, `ev-sealed-${i}`, 3000 + i, "run-b", "message", null, "seg-1", offset, len);
    db.query("INSERT INTO events_fts (rowid, body) VALUES (?, ?)").run(10 + i, body);
    offset += len;
  });
}

const lazy = lazyBoot({
  seed: (db) => {
    sessions.admin = seedSession(db, { admin: true });
    sessions.member = seedSession(db);
    seedEvents(db);
  },
});
afterAll(() => lazy.stop());

// The sessions are seeded when the server boots, so they are looked up after lazy.get().
async function search(q: string, who: "admin" | "member" | "anon" = "admin") {
  const server = await lazy.get();
  return api(server, who === "anon" ? undefined : sessions[who]).call(
    "GET",
    `/api/search?q=${encodeURIComponent(q)}`,
  );
}

test("C1-search: a word finds the event with a snippet around it [phase:1] [slice:logs] [focus:2]", async () => {
  const res = await search("deploy");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(await res.json()).toEqual([
    {
      rowid: 1,
      id: "ev-long",
      runId: "run-a",
      kind: "message",
      ts: 1000,
      snippet: LONG.slice(LONG.indexOf("Deploy") - 60, LONG.indexOf("Deploy") + 6 + 60),
    },
  ]);
});

test("C1-search: a command is found by substring, case-insensitively [phase:1] [slice:logs] [focus:2]", async () => {
  const res = await search("PUSH origin");
  expect(await res.json()).toEqual([
    {
      rowid: 2,
      id: "ev-cmd",
      runId: null,
      kind: "tool_call",
      ts: 2000,
      snippet: "git push origin main",
    },
  ]);
});

test("C1-search: bodies sealed into a zstd segment are searched and read back [phase:1] [slice:logs] [focus:2]", async () => {
  const res = await search("ąčę");
  expect(await res.json()).toEqual([
    {
      rowid: 11,
      id: "ev-sealed-1",
      runId: "run-b",
      kind: "message",
      ts: 3001,
      snippet: SEALED[1],
    },
  ]);
  const both = (await (await search("sealed")).json()) as { rowid: number }[];
  expect(both.map((h) => h.rowid).sort()).toEqual([10, 11]);
});

test("C1-search: no match is an empty list, FTS syntax stays literal [phase:1] [slice:logs] [focus:2]", async () => {
  expect(await (await search("nothingmatches")).json()).toEqual([]);
  expect(await (await search('"deploy" OR NOT')).json()).toEqual([]);
  expect(await (await search("NEAR(deploy host)")).json()).toEqual([]);
});

test("C1-search: q is trimmed, required and at most 200 characters [phase:1] [slice:logs] [focus:2]", async () => {
  const server = await lazy.get();
  const me = api(server, sessions.admin);
  const bad = async (path: string): Promise<void> => {
    const res = await me.call("GET", path);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid query" });
  };
  await bad("/api/search");
  await bad("/api/search?q=");
  await bad("/api/search?q=%20%20");
  await bad(`/api/search?q=${"x".repeat(201)}`);
  expect((await me.call("GET", `/api/search?q=${"x".repeat(200)}`)).status).toBe(200);
  expect((await me.call("GET", "/api/search?q=%20deploy%20")).status).toBe(200);
  expect(await (await me.call("GET", "/api/search?q=deploy&q=zzz")).json()).toHaveLength(1);
  expect(await (await me.call("GET", "/api/search?q=dep+loy")).json()).toEqual([]);
});

test("C1-search: a session and the instance admin flag are required [phase:1] [slice:logs] [focus:2]", async () => {
  const anon = await search("deploy", "anon");
  expect(anon.status).toBe(401);
  expect(await anon.json()).toEqual({ error: "unauthorized" });
  const member = await search("deploy", "member");
  expect(member.status).toBe(403);
  expect(await member.json()).toEqual({ error: "forbidden" });
});
