import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createApp } from "../../http";
import { type SessionOpts, sessionHeaders } from "../../test-support/app-kit";
import { createTask } from "../board/api";
import {
  addAgentMember,
  addHumanMember,
  createOrg,
  createProject,
  grantProject,
} from "../orgs/api";
import { drainCommits } from "./git-log";
import { logWrite } from "./index-log";

const ORIGIN = "http://localhost:4100";
let home: string;

beforeEach(() => {
  // A closed port keeps note classification off a real Laya.
  process.env.OLLAYA_URL = "http://127.0.0.1:1";
  home = mkdtempSync(join(tmpdir(), "harness-routes-"));
});
afterEach(async () => {
  delete process.env.OLLAYA_URL;
  await drainCommits();
  rmSync(home, { recursive: true, force: true });
});

async function boot() {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const app = createApp({
    db,
    home,
    port: 4100,
    rp: { id: "localhost", name: "Harness", origin: ORIGIN },
    instanceId: "i",
    version: "1",
  });
  const user = (opts: SessionOpts = {}) => sessionHeaders(db, { ...opts, origin: ORIGIN });
  const org = (slug: string, owner: { userId: string }) =>
    createOrg(db, {
      name: slug,
      slug,
      ownerUserId: owner.userId,
      ownerName: slug,
      ownerHandle: slug,
    });
  const call = (
    who: { headers: Record<string, string> },
    method: string,
    path: string,
    body?: unknown,
  ) =>
    Promise.resolve(
      app.request(path, {
        method,
        headers: who.headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const [alice, bob, carol] = [await user(), await user(), await user()] as const;
  const acme = org("acme", alice);
  const beta = org("beta", bob);
  return { db, call, alice, bob, carol, acme, beta, user };
}

const BASE = "/api/orgs/acme/memory";
const note = {
  scope: "org",
  rel: "deploy.md",
  body: "# Deploy\nrun the check first",
  type: "howto",
};

test("a member lists, searches and reads facets; the other org gets 404 on note, backlinks and revert", async () => {
  const k = await boot();
  const made = await (await k.call(k.alice, "POST", `${BASE}/notes`, note)).json();
  const id = made.note.id as string;
  const list = await (await k.call(k.alice, "GET", `${BASE}/notes?q=deploy&scope=org`)).json();
  expect(list.map((n: { id: string }) => n.id)).toEqual([id]);
  const facets = await (await k.call(k.alice, "GET", `${BASE}/facets`)).json();
  expect(facets.scopes.org).toBe(1);
  expect((await k.call(k.alice, "GET", `${BASE}/notes/${id}`)).status).toBe(200);

  // Bob owns beta and reaches it through his own org slug, so the id is the only thing crossing.
  const theirs = "/api/orgs/beta/memory";
  expect((await k.call(k.bob, "GET", `${theirs}/notes/${id}`)).status).toBe(404);
  expect((await k.call(k.bob, "GET", `${theirs}/notes/${id}/backlinks`)).status).toBe(404);
  const writes = await (await k.call(k.alice, "GET", `${BASE}/writes`)).json();
  expect(writes).toHaveLength(1);
  expect((await k.call(k.bob, "POST", `${theirs}/writes/${writes[0].id}/revert`)).status).toBe(404);
  expect((await k.call(k.bob, "GET", `${BASE}/notes`)).status).toBe(404);
  expect(await (await k.call(k.bob, "GET", `${theirs}/notes?q=deploy`)).json()).toEqual([]);
});

test("a stale PUT answers 409 with the current hash, a fresh one updates", async () => {
  const k = await boot();
  const made = await (await k.call(k.alice, "POST", `${BASE}/notes`, note)).json();
  const { id, hash } = made.note;
  const ok = await k.call(k.alice, "PUT", `${BASE}/notes/${id}`, {
    baseHash: hash,
    body: "# Deploy\nv2",
  });
  expect(ok.status).toBe(200);
  const next = (await ok.json()).note.hash;
  const stale = await k.call(k.alice, "PUT", `${BASE}/notes/${id}`, { baseHash: hash, body: "x" });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ error: "conflict", hash: next });
  expect((await k.call(k.alice, "DELETE", `${BASE}/notes/${id}?baseHash=${next}`)).status).toBe(
    200,
  );
  expect((await k.call(k.alice, "GET", `${BASE}/notes/${id}`)).status).toBe(404);
});

test("a secret in a posted note is stored redacted", async () => {
  const k = await boot();
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
  const res = await (
    await k.call(k.alice, "POST", `${BASE}/notes`, {
      ...note,
      rel: "key.md",
      body: `token ${secret}`,
    })
  ).json();
  expect(res.redacted).toBe(true);
  expect(res.note.body).not.toContain(secret);
});

test("revert restores the earlier text and the write feed shows before and after", async () => {
  const k = await boot();
  const made = await (await k.call(k.alice, "POST", `${BASE}/notes`, note)).json();
  const { id, hash } = made.note;
  await k.call(k.alice, "PUT", `${BASE}/notes/${id}`, {
    baseHash: hash,
    body: "# Deploy\nchanged",
  });
  const writes = await (await k.call(k.alice, "GET", `${BASE}/writes`)).json();
  expect(writes[0].op).toBe("update");
  expect(writes[0].before).toContain("run the check first");
  expect(writes[0].after).toContain("changed");
  const rev = await k.call(k.alice, "POST", `${BASE}/writes/${writes[0].id}/revert`);
  expect(rev.status).toBe(200);
  expect((await rev.json()).note.body).toContain("run the check first");
});

test("global writes need an instance admin and a viewer role cannot write or see the feed", async () => {
  const k = await boot();
  const global = { ...note, scope: "global", rel: "g.md" };
  expect((await k.call(k.alice, "POST", `${BASE}/notes`, global)).status).toBe(403);
  const admin = await k.user({ admin: true });
  addHumanMember(k.db, k.acme.id, admin.userId, "root", "root", "member");
  expect((await k.call(admin, "POST", `${BASE}/notes`, global)).status).toBe(201);
  addHumanMember(k.db, k.acme.id, k.carol.userId, "carol", "carol", "viewer");
  expect((await k.call(k.carol, "GET", `${BASE}/notes`)).status).toBe(200);
  expect((await k.call(k.carol, "POST", `${BASE}/notes`, note)).status).toBe(403);
  expect((await k.call(k.carol, "GET", `${BASE}/writes`)).status).toBe(403);
});

test("a project note stays with its owner org even when the project is granted to another org", async () => {
  const k = await boot();
  const project = createProject(k.db, { orgId: k.acme.id, key: "web", name: "Web" });
  const body = { scope: "project", projectId: project.id, rel: "p.md", body: "# P\nsecret plan" };
  const made = await (await k.call(k.alice, "POST", `${BASE}/notes`, body)).json();
  const owner = k.db
    .query<{ id: string }, [string]>("SELECT id FROM members WHERE org_id = ?")
    .get(k.acme.id);
  grantProject(k.db, project.id, k.beta.id, "read", owner?.id ?? "");
  const theirs = "/api/orgs/beta/memory";
  expect((await k.call(k.bob, "GET", `${theirs}/notes/${made.note.id}`)).status).toBe(404);
  expect(
    await (await k.call(k.bob, "GET", `${theirs}/notes?project=${project.id}`)).json(),
  ).toEqual([]);
  // A project of another org cannot be a write target either.
  const foreign = { ...body, rel: "q.md" };
  expect((await k.call(k.bob, "POST", `${theirs}/notes`, foreign)).status).toBe(403);
});

test("lesson decide is admin-only and an accepted lesson becomes a note", async () => {
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
  const pending = await (await k.call(k.alice, "GET", `${BASE}/lessons?status=pending`)).json();
  expect(pending).toHaveLength(1);
  expect(pending[0].task).toEqual({ number: task.number, projectId: project.id, title: "t" });
  addHumanMember(k.db, k.acme.id, k.carol.userId, "carol", "carol", "member");
  const body = { decision: "accept", reason: "good" };
  expect((await k.call(k.carol, "POST", `${BASE}/lessons/l1`, body)).status).toBe(403);
  // The owner is also the lesson's author here, so a second admin decides.
  const boss = await k.user();
  addHumanMember(k.db, k.acme.id, boss.userId, "boss", "boss", "admin");
  expect((await k.call(k.bob, "POST", `${BASE}/lessons/l1`, body)).status).toBe(404);
  const res = await k.call(boss, "POST", `${BASE}/lessons/l1`, body);
  expect(res.status).toBe(200);
  const decided = await res.json();
  expect(decided.status).toBe("accepted");
  expect((await k.call(k.alice, "GET", `${BASE}/notes/${decided.noteId}`)).status).toBe(200);
});

test("the write feed fills its limit with visible writes when newer ones sit in an inaccessible project", async () => {
  const k = await boot();
  const base = { noteId: "n", orgId: k.acme.id, op: "update" as const, actor: "x", memberId: null };
  const row = (disk: string) =>
    logWrite(k.db, {
      ...base,
      disk,
      runId: null,
      beforeText: null,
      afterText: "t",
      beforeHash: null,
      afterHash: null,
    });
  for (let i = 0; i < 3; i++) row(`orgs/${k.acme.id}/org/visible-${i}.md`);
  for (let i = 0; i < 60; i++) row(`orgs/${k.acme.id}/projects/hidden/h-${i}.md`);
  const feed = await (await k.call(k.alice, "GET", `${BASE}/writes?limit=50`)).json();
  expect(feed).toHaveLength(3);
});

test("the write feed marks only undoable rows as revertible", async () => {
  const k = await boot();
  const row = (op: "update" | "rename" | "outside", disk: string) =>
    logWrite(k.db, {
      noteId: "n",
      orgId: k.acme.id,
      op,
      actor: "x",
      memberId: null,
      disk,
      runId: null,
      beforeText: "a",
      afterText: "b",
      beforeHash: null,
      afterHash: null,
    });
  for (const op of ["update", "rename", "outside"] as const) {
    row(op, `orgs/${k.acme.id}/org/${op}.md`);
  }
  const feed = await (await k.call(k.alice, "GET", `${BASE}/writes`)).json();
  const byOp = Object.fromEntries(
    feed.map((w: { op: string; canRevert: boolean }) => [w.op, w.canRevert]),
  );
  expect(byOp).toEqual({ update: true, rename: false, outside: false });
});
