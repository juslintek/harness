import { expect, test } from "bun:test";
import { createTask } from "../board/api";
import {
  addAgentMember,
  addHumanMember,
  createProject,
  memberForUser,
  updateMember,
} from "../orgs/api";
import { BASE, boot, type Kit, useHome } from "./routes-test-kit";

useHome();

// The member is demoted from inside the body stream, so the demotion lands after the route's first
// role check and before it writes.
function demotedWhileReading(k: Kit, userId: string, payload: unknown): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return new ReadableStream({
    pull(ctl) {
      const m = memberForUser(k.db, k.acme.id, userId);
      // One step down: a viewer would be refused by the lesson reviewer check anyway.
      updateMember(k.db, m?.id as string, { role: m?.role === "admin" ? "member" : "viewer" });
      ctl.enqueue(bytes);
      ctl.close();
    },
  });
}

function streamed(
  k: Kit,
  who: { headers: Record<string, string>; userId: string },
  method: string,
  path: string,
  payload: unknown,
) {
  return k.app.request(path, {
    method,
    headers: who.headers,
    body: demotedWhileReading(k, who.userId, payload),
    duplex: "half",
  } as RequestInit);
}

test("a member demoted while a note PUT body is read gets 403 and nothing is written", async () => {
  const k = await boot();
  const made = await (
    await k.call(k.alice, "POST", `${BASE}/notes`, { scope: "org", rel: "a.md", body: "# A\none" })
  ).json();
  addHumanMember(k.db, k.acme.id, k.carol.userId, "carol", "carol", "member");
  const res = await streamed(k, k.carol, "PUT", `${BASE}/notes/${made.note.id}`, {
    baseHash: made.note.hash,
    body: "# A\ntwo",
  });
  expect(res.status).toBe(403);
  const now = await (await k.call(k.alice, "GET", `${BASE}/notes/${made.note.id}`)).json();
  expect(now.body).toContain("one");
});

test("an admin demoted while a lesson decision body is read gets 403 and the lesson stays pending", async () => {
  const k = await boot();
  const project = createProject(k.db, { orgId: k.acme.id, key: "web", name: "Web" });
  const agent = addAgentMember(k.db, k.acme.id, {
    agentId: "x",
    handle: "dev",
    displayName: "dev",
    specialties: [],
  });
  const task = createTask(k.db, { projectId: project.id, title: "t", createdBy: agent.id });
  k.db.run(
    `INSERT INTO lessons (id, task_id, org_id, project_id, author_id, author_handle, body, scope, type, status, created_at, confidence)
     VALUES ('l1', ?, ?, ?, ?, 'dev', ?, 'org', 'lesson', 'pending', 1, 0.8)`,
    [
      task.id,
      k.acme.id,
      project.id,
      agent.id,
      "Run the full check before you push because CI fails late.",
    ],
  );
  addHumanMember(k.db, k.acme.id, k.carol.userId, "carol", "carol", "admin");
  const res = await streamed(k, k.carol, "POST", `${BASE}/lessons/l1`, {
    decision: "accept",
    reason: "ok",
  });
  expect(res.status).toBe(403);
  const status = k.db
    .query<{ status: string }, []>("SELECT status FROM lessons WHERE id = 'l1'")
    .get();
  expect(status?.status).toBe("pending");
});
