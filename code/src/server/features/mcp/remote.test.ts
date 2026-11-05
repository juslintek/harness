import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type ApiKit, bootApi } from "../../test-support/api-kit";
import { createTask } from "../board/api";
import { listChannels } from "../chat/api";
import { mintLocalLinkToken } from "../oauth/api";
import { createProject, removeMember } from "../orgs/api";
import { mintRunToken, type TokenScope } from "./api";
import { REMOTE_TOOLS } from "./tools-remote";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop(true);
});

// The whole app is served, so hostGuard and the mount in http.ts are part of what is tested. The
// app expects its configured Host, which a loopback client must send explicitly.
async function serve(kit: Boot): Promise<ReturnType<typeof Bun.serve>> {
  const server = Bun.serve({ port: 0, fetch: (req) => kit.api.app.fetch(req) });
  servers.push(server);
  return server;
}

async function connect(server: ReturnType<typeof Bun.serve>, token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp/remote`), {
      requestInit: { headers: { authorization: `Bearer ${token}`, host: "localhost:4100" } },
    }),
  );
  return client;
}

async function call(
  server: ReturnType<typeof Bun.serve>,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string }> {
  const client = await connect(server, token);
  try {
    const result = await client.callTool({ name, arguments: args });
    return {
      isError: result.isError === true,
      text: (result.content as { text: string }[])[0]?.text ?? "",
    };
  } finally {
    await client.close();
  }
}

interface Boot {
  api: ApiKit;
  owner: Awaited<ReturnType<ApiKit["user"]>>;
  org: { id: string; owner: { id: string } };
}

async function boot(): Promise<Boot> {
  const api = bootApi();
  const owner = await api.user({ stepUp: true });
  return { api, owner, org: api.org(owner, "acme") };
}

// Org A is the token's org. The same human also holds a member in org B, which is the case a
// token-bound check has to survive: the user may reach B, the token may not.
async function world(scopes: TokenScope[] = ["board", "chat"]) {
  const kit = await boot();
  const { db } = kit.api;
  const server = await serve(kit);
  const owner = kit.org.owner.id;
  const projectA = createProject(db, { orgId: kit.org.id, key: "web", name: "Web" });
  const taskA = createTask(db, { projectId: projectA.id, title: "in a", createdBy: owner });
  const stranger = await kit.api.user();
  const orgB = kit.api.org(stranger, "beta");
  const memberB = kit.api.join(orgB.id, kit.owner, "admin", "ownerb");
  const projectB = createProject(db, { orgId: orgB.id, key: "web", name: "Web B" });
  const taskB = createTask(db, { projectId: projectB.id, title: "in b", createdBy: memberB.id });
  const channelA = listChannels(db, owner)[0];
  const channelB = listChannels(db, memberB.id)[0];
  if (!channelA || !channelB) throw new Error("no channels");
  const token = mintLocalLinkToken(db, owner, kit.org.id);
  db.query("UPDATE oauth_tokens SET scopes = ?").run(scopes.join(" "));
  return { kit, db, server, token, owner, taskA, taskB, channelA, channelB, projectB, orgB };
}

test("the allow-list is exactly the board and chat tools a collaborator needs", async () => {
  const w = await world();
  const client = await connect(w.server, w.token);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  await client.close();
  expect(names).toEqual(Object.keys(REMOTE_TOOLS).sort());
  expect(names).toEqual([
    "board_list",
    "chat_channels",
    "chat_post",
    "chat_read",
    "task_comment",
    "task_create",
    "task_get",
    "task_move",
  ]);
});

test("board and chat calls work for the granted org and are attributed to the human", async () => {
  const w = await world();
  const list = await call(w.server, w.token, "board_list");
  expect(list.text).toContain("in a");
  expect(list.text).not.toContain("in b");
  const posted = await call(w.server, w.token, "chat_post", {
    channel: w.channelA.id,
    body: "hello from claude.ai",
  });
  expect(posted.isError).toBe(false);
  const created = await call(w.server, w.token, "task_create", { project: "web", title: "new" });
  expect(created.isError).toBe(false);
  const rows = w.db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM events WHERE source = 'remote_mcp' AND run_id IS NULL AND agent = 'own-acme'",
    )
    .get();
  expect(rows?.n).toBe(3);
});

test("the token's org binds every call, even for a member of both orgs", async () => {
  const w = await world();
  const refused = [
    await call(w.server, w.token, "chat_read", { channel: w.channelB.id }),
    await call(w.server, w.token, "chat_post", { channel: w.channelB.id, body: "x" }),
    await call(w.server, w.token, "task_get", { task: w.taskB.id }),
    await call(w.server, w.token, "task_comment", { task: w.taskB.id, body: "x" }),
    await call(w.server, w.token, "task_move", { task: w.taskB.id, to: "done" }),
    await call(w.server, w.token, "task_create", { project: w.projectB.id, title: "x" }),
    await call(w.server, w.token, "task_create", {
      project: "web",
      title: "x",
      parent: w.taskB.id,
    }),
  ];
  for (const r of refused) expect(r.isError).toBe(true);
  expect(w.db.query("SELECT 1 FROM tasks WHERE title = 'x'").get()).toBeNull();
  expect(w.db.query("SELECT 1 FROM messages WHERE body = 'x'").get()).toBeNull();
});

test("a board-only token cannot list or call chat tools", async () => {
  const w = await world(["board"]);
  const client = await connect(w.server, w.token);
  const names = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  expect(names.some((n) => n.startsWith("chat_"))).toBe(false);
  expect(names).toContain("board_list");
  const res = await call(w.server, w.token, "chat_post", { channel: w.channelA.id, body: "y" });
  expect(res.isError).toBe(true);
  expect(w.db.query("SELECT 1 FROM messages WHERE body = 'y'").get()).toBeNull();
});

test("scopes narrowed after connecting refuse the next call", async () => {
  const w = await world();
  const client = await connect(w.server, w.token);
  w.db.query("UPDATE oauth_tokens SET scopes = 'board'").run();
  const res = await client.callTool({
    name: "chat_post",
    arguments: { channel: w.channelA.id, body: "z" },
  });
  await client.close();
  expect(res.isError).toBe(true);
  expect(w.db.query("SELECT 1 FROM messages WHERE body = 'z'").get()).toBeNull();
});

test("a revoked grant is a 401 on the next call", async () => {
  const w = await world();
  const client = await connect(w.server, w.token);
  expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  const list = await w.kit.api.call(w.kit.owner, "GET", "/api/oauth/grants");
  const grants = (await list.json()) as { id: string }[];
  await w.kit.api.call(w.kit.owner, "DELETE", `/api/oauth/grants/${grants[0]?.id}`);
  await expect(client.callTool({ name: "board_list", arguments: {} })).rejects.toThrow();
  await client.close();
  const res = await fetch(`http://127.0.0.1:${w.server.port}/mcp/remote`, {
    method: "POST",
    headers: { authorization: `Bearer ${w.token}`, host: "localhost:4100" },
  });
  expect(res.status).toBe(401);
});

test("a member removed from the org is refused on the next call", async () => {
  const w = await world();
  const client = await connect(w.server, w.token);
  removeMember(w.db, w.owner);
  await expect(client.callTool({ name: "board_list", arguments: {} })).rejects.toThrow();
  await client.close();
});

function post(w: Awaited<ReturnType<typeof world>>, path: string, host: string, auth?: string) {
  return w.kit.api.app.request(path, {
    method: "POST",
    headers: { host, ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
  });
}

test("401 points at the protected resource metadata, run tokens never open the remote endpoint", async () => {
  const w = await world();
  const none = await post(w, "/mcp/remote", "localhost:4100");
  expect(none.status).toBe(401);
  expect(none.headers.get("www-authenticate")).toBe(
    `Bearer resource_metadata="http://localhost:4100/.well-known/oauth-protected-resource/mcp/remote"`,
  );
  const run = mintRunToken(w.db, "run-1", ["board", "chat"], {
    memberId: w.owner,
    orgId: w.kit.org.id,
  });
  const res = await post(w, "/mcp/remote", "localhost:4100", run);
  expect(res.status).toBe(401);
  const bad = await post(w, "/mcp/remote", "localhost:4100", "nope");
  expect(bad.status).toBe(401);
});

test("an oauth token never opens the loopback /mcp, and unknown tokens are 401 there", async () => {
  const w = await world();
  const loopback = "127.0.0.1:4100";
  expect((await post(w, "/mcp", loopback, w.token)).status).toBe(401);
  expect((await post(w, "/mcp", loopback, "unknown")).status).toBe(401);
});

test("only the configured host reaches /mcp/remote, the loopback exemption does not cover it", async () => {
  const w = await world();
  expect((await post(w, "/mcp/remote", "evil.test", w.token)).status).toBe(403);
  expect((await post(w, "/mcp/remote", "127.0.0.1:4100", w.token)).status).toBe(403);
  const get = await w.kit.api.app.request("/mcp/remote", { headers: { host: "localhost:4100" } });
  expect(get.status).toBe(405);
  const del = await w.kit.api.app.request("/mcp/remote", {
    method: "DELETE",
    headers: { host: "localhost:4100" },
  });
  expect(del.status).toBe(405);
});

test("a role downgrade after the grant is honoured on the next call: viewers read but never write", async () => {
  const w = await world();
  const made = await call(w.server, w.token, "task_create", { project: "web", title: "before" });
  expect(made.isError).toBe(false);
  w.db.query("UPDATE members SET role = 'viewer' WHERE id = ?").run(w.owner);
  const denied = await call(w.server, w.token, "task_create", { project: "web", title: "after" });
  expect(denied.isError).toBe(true);
  expect((await call(w.server, w.token, "board_list")).isError).toBe(false);
});
