import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { listChannels, listMessages, wireChat } from "../chat/api";
import { addAgentMember, createOrg, createPosition, createProject } from "../orgs/api";
import { mcpHandler, mintRunToken, type TokenScope } from "./api";

type Db = ReturnType<typeof openDb>;
let db: Db;
let server: ReturnType<typeof Bun.serve>;

async function listen(database: Db): Promise<ReturnType<typeof Bun.serve>> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const own: ReturnType<typeof Bun.serve> = Bun.serve({
      port: 0,
      fetch: (req) => mcpHandler(database, { onReport: () => {} }, own.port as number)(req),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${own.port}/`, {
        method: "POST",
        keepalive: false,
      });
      if (res.status === 401) return own;
    } catch {
      // port unreachable, try another
    }
    await own.stop(true);
  }
  throw new Error("no loopback port became reachable");
}

function pendingApproval(database: Db, memberId: string): string {
  const runId = Bun.randomUUIDv7();
  const id = Bun.randomUUIDv7();
  database.run(
    "INSERT INTO runs (id, member_id, agent_id, repo, prompt, state, created_at) VALUES (?, ?, 'a', '/r', 'p', 'running', 1)",
    [runId, memberId],
  );
  database.run(
    "INSERT INTO approvals (id, run_id, action, l1, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', 1, ?)",
    [
      id,
      runId,
      JSON.stringify({ kind: "execute", command: "bun test", paths: [] }),
      JSON.stringify({ verdict: "ask", rule: "r", reason: "x", category: "shell" }),
      Date.now() + 60_000,
    ],
  );
  return id;
}

const ALL: TokenScope[] = ["report", "guard_hook", "board", "chat"];

function world(database: Db) {
  const org = (slug: string, handle: string) =>
    createOrg(database, {
      name: slug,
      slug,
      ownerUserId: handle,
      ownerName: handle,
      ownerHandle: handle,
    });
  const a = org("acme", "owner");
  const b = org("beta", "boss");
  wireChat(database);
  const agent = (orgId: string, handle: string) =>
    addAgentMember(database, orgId, { agentId: "x", handle, displayName: handle, specialties: [] });
  const project = createProject(database, { orgId: a.id, key: "web", name: "Web" });
  const projectB = createProject(database, { orgId: b.id, key: "web", name: "Web B" });
  return { a, b, agent, project, projectB };
}

function tokenFor(memberId: string, orgId: string, scopes: TokenScope[] = ALL): string {
  return mintRunToken(db, Bun.randomUUIDv7(), scopes, { memberId, orgId });
}

async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  const text = (result.content as { text: string }[])[0]?.text ?? "";
  return { isError: result.isError === true, text };
}

beforeEach(async () => {
  db = openDb(":memory:");
  migrate(db, migrations);
  server = await listen(db);
});
afterEach(() => {
  server.stop(true);
});

test("a token without a member cannot use board tools", async () => {
  const token = mintRunToken(db, "run-1", ALL);
  const r = await call(token, "board_list");
  expect(r.isError).toBe(true);
  expect(r.text).toContain("no member");
});

test("whoami shows member, org, handle and positions", async () => {
  const w = world(db);
  const boss = w.agent(w.a.id, "boss");
  createPosition(db, { orgId: w.a.id, title: "lead", memberId: boss.id, isManager: true });
  const r = await call(tokenFor(boss.id, w.a.id), "whoami");
  expect(JSON.parse(r.text).member).toMatchObject({
    handle: "boss",
    orgId: w.a.id,
    positions: [{ title: "lead", isManager: true }],
  });
});

test("two agents race for a checkout: one wins, the other is told who holds it", async () => {
  const w = world(db);
  const [x, y] = [w.agent(w.a.id, "ax"), w.agent(w.a.id, "ay")] as const;
  const created = await call(tokenFor(x.id, w.a.id), "task_create", { project: "web", title: "t" });
  const { number } = JSON.parse(created.text);
  const [rx, ry] = await Promise.all([
    call(tokenFor(x.id, w.a.id), "task_checkout", { task: number }),
    call(tokenFor(y.id, w.a.id), "task_checkout", { task: number }),
  ]);
  const winner = rx.isError ? ry : rx;
  const loser = rx.isError ? rx : ry;
  expect(winner.isError).toBe(false);
  expect(loser.text).toBe(`held by @${rx.isError ? "ay" : "ax"}`);
  expect(JSON.parse(winner.text).holder).toBe(rx.isError ? "ay" : "ax");
});

test("board tools list, get, update, comment, move and depend", async () => {
  const w = world(db);
  const x = w.agent(w.a.id, "ax");
  const t = tokenFor(x.id, w.a.id);
  const one = JSON.parse(
    (await call(t, "task_create", { project: "web", title: "one", assignee: "ax" })).text,
  );
  const two = JSON.parse(
    (await call(t, "task_create", { project: "web", title: "two", parent: one.number })).text,
  );
  expect((await call(t, "task_depend", { task: one.number, dependsOn: two.number })).isError).toBe(
    false,
  );
  expect(
    (await call(t, "task_update", { task: one.number, title: "uno", estimateMinutes: 30 })).isError,
  ).toBe(false);
  expect((await call(t, "task_comment", { task: one.number, body: "hello" })).isError).toBe(false);
  expect((await call(t, "task_move", { task: one.number, to: "done" })).text).toContain(
    "open tasks",
  );
  const got = JSON.parse((await call(t, "task_get", { task: one.number })).text);
  expect(got).toMatchObject({ title: "uno", estimateMinutes: 30, assignee: "ax" });
  expect(got.comments[0]).toMatchObject({ author: "ax", body: "hello" });
  expect(got.subtasks).toHaveLength(1);
  const mine = JSON.parse((await call(t, "board_list", { mine: true })).text);
  expect(mine.map((r: { title: string }) => r.title)).toEqual(["uno"]);
});

test("an agent of another org cannot see or touch this org's board", async () => {
  const w = world(db);
  const x = w.agent(w.a.id, "ax");
  const outsider = w.agent(w.b.id, "bz");
  const made = JSON.parse(
    (await call(tokenFor(x.id, w.a.id), "task_create", { project: "web", title: "secret" })).text,
  );
  const t = tokenFor(outsider.id, w.b.id);
  expect(JSON.parse((await call(t, "board_list")).text)).toEqual([]);
  expect((await call(t, "task_get", { task: made.id })).isError).toBe(true);
  expect((await call(t, "task_get", { task: made.number })).isError).toBe(true);
  expect((await call(t, "task_checkout", { task: made.id })).isError).toBe(true);
  expect((await call(t, "task_create", { project: w.project.id, title: "x" })).isError).toBe(true);
});

test("chat_post stores the mention and chat_read marks the channel read", async () => {
  const w = world(db);
  const [x, y] = [w.agent(w.a.id, "ax"), w.agent(w.a.id, "bb")] as const;
  const posted = await call(tokenFor(x.id, w.a.id), "chat_post", {
    channel: "general",
    body: "ping @bb",
  });
  expect(posted.isError).toBe(false);
  const general = listChannels(db, y.id).find((c) => c.name === "general");
  expect(general?.unread).toBe(1);
  const messages = listMessages(db, general?.id ?? "", {});
  expect(messages[0]?.mentions).toEqual([y.id]);

  const read = JSON.parse(
    (await call(tokenFor(y.id, w.a.id), "chat_read", { channel: "#general" })).text,
  );
  expect(read[0]).toMatchObject({ author: "ax", body: "ping @bb", replyCount: 0 });
  expect(listChannels(db, y.id).find((c) => c.name === "general")?.unread).toBe(0);
  const names = JSON.parse((await call(tokenFor(y.id, w.a.id), "chat_channels")).text);
  expect(names.map((c: { name: string }) => c.name)).toContain("general");
});

test("chat_dm opens a private channel only the two members see", async () => {
  const w = world(db);
  const [x, y, z] = [w.agent(w.a.id, "ax"), w.agent(w.a.id, "ay"), w.agent(w.a.id, "az")] as const;
  expect(
    (await call(tokenFor(x.id, w.a.id), "chat_dm", { handle: "@ay", body: "psst" })).isError,
  ).toBe(false);
  expect(listChannels(db, y.id).some((c) => c.kind === "dm")).toBe(true);
  expect(listChannels(db, z.id).some((c) => c.kind === "dm")).toBe(false);
  expect(
    (await call(tokenFor(x.id, w.a.id), "chat_dm", { handle: "nobody", body: "hi" })).isError,
  ).toBe(true);
});

test("approvals_decide needs its scope and a manager over the requester", async () => {
  const w = world(db);
  const [boss, dev] = [w.agent(w.a.id, "boss"), w.agent(w.a.id, "dev")] as const;
  const lead = createPosition(db, {
    orgId: w.a.id,
    title: "lead",
    memberId: boss.id,
    isManager: true,
  });
  createPosition(db, { orgId: w.a.id, title: "dev", memberId: dev.id, reportsTo: lead.id });
  const pending = pendingApproval(db, dev.id);

  const noScope = await call(tokenFor(boss.id, w.a.id, ["board"]), "approvals_decide", {
    id: pending,
    decision: "approve",
    reason: "fine",
  });
  expect(noScope.isError).toBe(true);
  expect(noScope.text).toContain("approvals_decide");

  const manager = tokenFor(boss.id, w.a.id, ["approvals_decide"]);
  expect(
    JSON.parse((await call(manager, "approvals_list")).text).map((a: { id: string }) => a.id),
  ).toEqual([pending]);
  const peerToken = tokenFor(dev.id, w.a.id, ["approvals_decide"]);
  expect(
    (await call(peerToken, "approvals_decide", { id: pending, decision: "approve", reason: "me" }))
      .isError,
  ).toBe(true);
  expect(
    (await call(manager, "approvals_decide", { id: pending, decision: "approve", reason: "fine" }))
      .text,
  ).toBe("ok");
  const row = db
    .query<{ status: string }, [string]>("SELECT status FROM approvals WHERE id = ?")
    .get(pending);
  expect(row?.status).toBe("approved");
});
