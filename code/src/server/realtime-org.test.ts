import { afterEach, expect, test } from "bun:test";
import { type WsMessage, wsMessageSchema } from "../shared/realtime";
import { migrate, openDb } from "./db/db";
import { migrations } from "./db/migrations";
import { wireChat } from "./features/chat/api";
import { addHumanMember, createOrg, createProject, grantProject } from "./features/orgs/api";
import { createApp } from "./http";
import { wireRealtime } from "./realtime";
import { listenDeferred, openSocket, sessionHeaders, until } from "./test-support/app-kit";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

async function boot() {
  const db = openDb(":memory:");
  migrate(db, migrations);
  wireChat(db);
  const { server, port, attach } = listenDeferred();
  const origin = `http://localhost:${port}`;
  attach(
    createApp({
      db,
      home: "/unused",
      port,
      rp: { id: "localhost", name: "Harness", origin },
      instanceId: "i",
      version: "1",
    }),
  );
  stops.push(wireRealtime(db, server), () => void server.stop(true));
  const user = async (admin = false) => sessionHeaders(db, { admin, origin });
  const org = (slug: string, who: { userId: string }) =>
    createOrg(db, {
      name: slug,
      slug,
      ownerUserId: who.userId,
      ownerName: slug,
      ownerHandle: slug,
    });
  const listen = async (who: { headers: Record<string, string> }, topic: string) => {
    const ws = await openSocket(`ws://127.0.0.1:${port}/ws?topic=${topic}`, who.headers);
    const seen: WsMessage[] = [];
    ws.onmessage = (e) => seen.push(wsMessageSchema.parse(JSON.parse(String(e.data))));
    stops.push(() => ws.close());
    return seen;
  };
  const post = (who: { headers: Record<string, string> }, path: string, body: object) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { ...who.headers, host: `localhost:${port}` },
      body: JSON.stringify(body),
    });
  return { db, user, org, listen, post, port };
}

test("an org topic refuses users outside the org and run topics refuse non-admins", async () => {
  const k = await boot();
  const [alice, bob] = [await k.user(), await k.user()] as [
    Awaited<ReturnType<typeof k.user>>,
    Awaited<ReturnType<typeof k.user>>,
  ];
  const a = k.org("acme", alice);
  k.org("beta", bob);
  const denied = await fetch(`http://127.0.0.1:${k.port}/ws?topic=org:${a.id}`, {
    headers: { ...bob.headers, host: `localhost:${k.port}` },
  });
  expect(denied.status).toBe(403);
  await expect(k.listen(bob, `org:${a.id}`)).rejects.toThrow();
  await expect(k.listen(alice, "runs")).rejects.toThrow();
  await expect(k.listen(await k.user(true), `org:${a.id}`)).rejects.toThrow();
  await k.listen(alice, `org:${a.id}`);
  await k.listen(await k.user(true), "runs");
});

test("a member hears a task nudge after a task is created and a chat nudge after a message", async () => {
  const k = await boot();
  const [alice, viewer] = [await k.user(), await k.user()] as [
    Awaited<ReturnType<typeof k.user>>,
    Awaited<ReturnType<typeof k.user>>,
  ];
  const a = k.org("acme", alice);
  addHumanMember(k.db, a.id, viewer.userId, "view", "view", "viewer");
  const project = createProject(k.db, { orgId: a.id, key: "web", name: "Web" });
  const heard = await k.listen(viewer, `org:${a.id}`);

  const task = await (
    await k.post(alice, `/api/projects/${project.id}/tasks`, { title: "t" })
  ).json();
  await until(() => heard.length === 1);
  expect(heard[0]).toEqual({
    type: "task",
    projectId: project.id,
    taskId: task.id,
    kind: "created",
  });

  const channel = k.db
    .query<{ id: string }, [string]>("SELECT id FROM channels WHERE org_id = ? AND kind = 'org'")
    .get(a.id);
  const msg = await (
    await k.post(alice, `/api/channels/${channel?.id}/messages`, { body: "hello" })
  ).json();
  await until(() => heard.length === 2);
  expect(heard[1]).toEqual({
    type: "chat",
    channelId: channel?.id as string,
    messageId: msg.id,
    threadRootId: null,
  });
});

test("a granted project also nudges the grantee org", async () => {
  const k = await boot();
  const [alice, bob] = [await k.user(), await k.user()] as [
    Awaited<ReturnType<typeof k.user>>,
    Awaited<ReturnType<typeof k.user>>,
  ];
  const a = k.org("acme", alice);
  const b = k.org("beta", bob);
  const project = createProject(k.db, { orgId: a.id, key: "web", name: "Web" });
  const owner = k.db
    .query<{ id: string }, [string]>("SELECT id FROM members WHERE org_id = ?")
    .get(a.id);
  grantProject(k.db, project.id, b.id, "write", owner?.id as string);
  const heard = await k.listen(bob, `org:${b.id}`);
  await k.post(alice, `/api/projects/${project.id}/tasks`, { title: "shared" });
  await until(() => heard.length === 1);
  expect(heard[0]?.type).toBe("task");
});
