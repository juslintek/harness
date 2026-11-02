import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootApi } from "../../test-support/api-kit";
import { createEnrollment, enrollmentUser, redeemEnrollment } from "../auth/api";
import { createProject, grantProject } from "./api";

test("creating an org makes the caller its owner and strangers get 404", async () => {
  const k = bootApi();
  const [alice, bob] = [await k.user(), await k.user()] as [
    Awaited<ReturnType<typeof k.user>>,
    Awaited<ReturnType<typeof k.user>>,
  ];
  const made = await k.call(alice, "POST", "/api/orgs", { name: "Acme", slug: "acme" });
  expect(made.status).toBe(201);
  expect(await (await k.call(alice, "GET", "/api/orgs")).json()).toHaveLength(1);
  const detail = await (await k.call(alice, "GET", "/api/orgs/acme")).json();
  expect(detail.me.role).toBe("owner");
  expect(detail.teams.map((t: { name: string }) => t.name)).toEqual(["Core"]);
  expect((await k.call(bob, "GET", "/api/orgs/acme")).status).toBe(404);
  expect((await k.call(alice, "POST", "/api/orgs", { name: "Again", slug: "acme" })).status).toBe(
    409,
  );
  expect(
    (await k.call(alice, "POST", "/api/orgs", { name: "X", slug: "x1", extra: 1 })).status,
  ).toBe(400);
});

test("role changes need step-up, only owners touch ownership and the last owner stays", async () => {
  const k = bootApi();
  const owner = await k.user({ stepUp: true });
  const admin = await k.user({ stepUp: true });
  const o = k.org(owner, "acme");
  const adminMember = k.join(o.id, admin, "admin", "adm");
  const viewer = k.join(o.id, await k.user(), "viewer", "view");
  const patch = (who: typeof owner, id: string, role: string) =>
    k.call(who, "PATCH", `/api/orgs/acme/members/${id}`, { role });

  const noStepUp = await k.user();
  k.join(o.id, noStepUp, "admin", "adm2");
  const denied = await patch(noStepUp, viewer.id, "member");
  expect(denied.status).toBe(403);
  expect((await denied.json()).error).toBe("step_up_required");

  expect((await patch(admin, viewer.id, "member")).status).toBe(200);
  expect((await patch(admin, viewer.id, "owner")).status).toBe(403);
  expect((await patch(admin, o.owner.id, "member")).status).toBe(403);
  expect((await patch(owner, adminMember.id, "owner")).status).toBe(200);

  expect((await patch(owner, o.owner.id, "member")).status).toBe(200);
  const lastOne = await patch(admin, adminMember.id, "member");
  expect(lastOne.status).toBe(409);
  expect((await lastOne.json()).error).toBe("last_owner");
  const remove = k.call(admin, "DELETE", `/api/orgs/acme/members/${adminMember.id}`);
  expect((await remove).status).toBe(409);
});

test("a patch body is strict and a field left out keeps its stored value", async () => {
  const k = bootApi();
  const owner = await k.user();
  const o = k.org(owner, "acme");
  const bad = await k.call(owner, "PATCH", `/api/orgs/acme/members/${o.owner.id}`, { nope: 1 });
  expect(bad.status).toBe(400);
  const ok = await k.call(owner, "PATCH", `/api/orgs/acme/members/${o.owner.id}`, { paused: true });
  expect(await ok.json()).toMatchObject({ role: "owner", displayName: "acme", paused: true });
});

test("inviting a new address returns an enrollment link, a known user is added directly", async () => {
  const k = bootApi();
  const owner = await k.user({ stepUp: true });
  const known = await k.user();
  k.org(owner, "acme");
  const invite = (email: string, role = "member") =>
    k.call(owner, "POST", "/api/orgs/acme/members/humans", { email, role });
  const fresh = await (await invite("new@example.test")).json();
  expect(fresh.enrollmentLink).toMatch(/^http:\/\/localhost:4100\/#\/enroll\/\S+$/);
  expect(fresh.member.role).toBe("member");
  k.db.run(
    "INSERT INTO passkeys (id, user_id, public_key, counter, name, created_at) VALUES ('p', ?, x'00', 0, 'k', 1)",
    [known.userId],
  );
  const added = await (await invite(`${known.userId}@example.test`)).json();
  expect(added.enrollmentLink).toBeNull();
  expect((await invite(`${known.userId}@example.test`)).status).toBe(409);
});

test("inviting a known user without a passkey issues a fresh enrollment and expires the old one", async () => {
  const k = bootApi();
  const owner = await k.user({ stepUp: true });
  const pending = await k.user();
  k.org(owner, "acme");
  const email = `${pending.userId}@example.test`;
  const old = createEnrollment(k.db, { userId: pending.userId, email, ttlMs: 60_000 });
  const res = await (
    await k.call(owner, "POST", "/api/orgs/acme/members/humans", { email, role: "member" })
  ).json();
  const code = res.enrollmentLink.split("/").pop() as string;
  expect(enrollmentUser(k.db, code)).toBeNull();
  const profile = { email, name: "p" };
  expect(redeemEnrollment(k.db, old, profile)).toBeNull();
  expect(redeemEnrollment(k.db, code, profile)).toBe(pending.userId);
});

test("an admin cannot invite an owner", async () => {
  const k = bootApi();
  const owner = await k.user();
  const admin = await k.user({ stepUp: true });
  const o = k.org(owner, "acme");
  k.join(o.id, admin, "admin", "adm");
  const res = await k.call(admin, "POST", "/api/orgs/acme/members/humans", {
    email: "boss@example.test",
    role: "owner",
  });
  expect(res.status).toBe(403);
});

test("positions refuse members and teams of another org, and a manager flag needs step-up", async () => {
  const k = bootApi();
  const owner = await k.user();
  const stepped = await k.user({ stepUp: true });
  const a = k.org(owner, "acme");
  k.join(a.id, stepped, "admin", "adm");
  const betaOwner = await k.user();
  const b = k.org(betaOwner, "beta");
  const post = (who: typeof owner, body: object) =>
    k.call(who, "POST", "/api/orgs/acme/positions", body);
  expect((await post(owner, { title: "Lead", memberId: b.owner.id })).status).toBe(400);
  const foreign = await (
    await k.call(betaOwner, "POST", "/api/orgs/beta/teams", { name: "Ops" })
  ).json();
  expect((await post(owner, { title: "Lead", teamId: foreign.id })).status).toBe(400);
  expect((await post(owner, { title: "Lead", isManager: true })).status).toBe(403);
  const made = await post(stepped, { title: "Lead", memberId: a.owner.id, isManager: true });
  expect(made.status).toBe(201);
  const id = (await made.json()).id;
  const patch = (who: typeof owner, body: object) =>
    k.call(who, "PATCH", `/api/orgs/acme/positions/${id}`, body);
  expect((await patch(owner, { isManager: false })).status).toBe(403);
  expect((await patch(owner, { title: "Head" })).status).toBe(200);
  expect((await patch(stepped, { memberId: b.owner.id })).status).toBe(400);
});

test("grants need step-up and an admin of the owning org", async () => {
  const k = bootApi();
  const owner = await k.user({ stepUp: true });
  const plain = await k.user();
  const a = k.org(owner, "acme");
  k.join(a.id, plain, "admin", "adm");
  const b = k.org(await k.user(), "beta");
  const made = await k.call(owner, "POST", "/api/orgs/acme/projects", { key: "web", name: "Web" });
  expect(made.status).toBe(201);
  const project = await made.json();
  const grant = (who: typeof owner) =>
    k.call(who, "POST", `/api/projects/${project.id}/grants`, { orgId: b.id, permission: "read" });
  const noStepUp = await grant(plain);
  expect((await noStepUp.json()).error).toBe("step_up_required");
  expect((await grant(owner)).status).toBe(200);
  const outsider = await k.user({ stepUp: true });
  expect((await grant(outsider)).status).toBe(404);
  const revoke = await k.call(owner, "DELETE", `/api/projects/${project.id}/grants`, {
    orgId: b.id,
  });
  expect(revoke.status).toBe(200);
  const channels = k.db.query("SELECT 1 FROM channels WHERE project_id = ?").all(project.id);
  expect(channels).toHaveLength(1);
});

test("reassigning a manager position or removing an admin needs step-up", async () => {
  const k = bootApi();
  const owner = await k.user({ stepUp: true });
  const plain = await k.user();
  const o = k.org(owner, "acme");
  const plainMember = k.join(o.id, plain, "admin", "adm");
  const made = await k.call(owner, "POST", "/api/orgs/acme/positions", {
    title: "Lead",
    isManager: true,
  });
  const id = (await made.json()).id;
  const reassign = await k.call(plain, "PATCH", `/api/orgs/acme/positions/${id}`, {
    memberId: o.owner.id,
  });
  expect(reassign.status).toBe(403);
  expect((await reassign.json()).error).toBe("step_up_required");
  const remove = await k.call(owner, "DELETE", `/api/orgs/acme/members/${plainMember.id}`);
  expect(remove.status).toBe(200);
  const other = await k.user();
  const otherMember = k.join(o.id, other, "admin", "adm2");
  const noStep = await k.user();
  k.join(o.id, noStep, "admin", "adm3");
  const denied = await k.call(noStep, "DELETE", `/api/orgs/acme/members/${otherMember.id}`);
  expect((await denied.json()).error).toBe("step_up_required");
});

test("only the instance admin adds agent members, even to an org someone else owns", async () => {
  const k = bootApi();
  const owner = await k.user({ stepUp: true });
  const admin = await k.user({ admin: true, stepUp: true });
  const o = k.org(owner, "acme");
  k.join(o.id, admin, "admin", "boss");
  const body = { agentId: "claude", handle: "bot", displayName: "Bot" };
  const denied = await k.call(owner, "POST", "/api/orgs/acme/members/agents", body);
  expect(denied.status).toBe(403);
  const ok = await k.call(admin, "POST", "/api/orgs/acme/members/agents", body);
  expect(ok.status).toBe(201);
  const unknown = await k.call(admin, "POST", "/api/orgs/acme/members/agents", {
    ...body,
    handle: "ghost",
    agentId: "no-such-agent",
  });
  expect(unknown.status).toBe(400);
  expect((await unknown.json()).error).toBe("unknown agent");
});

test("an instance admin on an email-code session cannot add an agent or set a repo", async () => {
  const k = bootApi();
  const code = await k.user({ admin: true });
  const passkey = await k.user({ admin: true, stepUp: true });
  const o = k.org(code, "acme");
  k.join(o.id, passkey, "admin", "pk");
  const agent = { agentId: "claude", handle: "bot", displayName: "Bot" };
  const addAgent = (who: typeof code) =>
    k.call(who, "POST", "/api/orgs/acme/members/agents", agent);
  const denied = await addAgent(code);
  expect(denied.status).toBe(403);
  expect((await denied.json()).error).toBe("step_up_required");
  expect((await addAgent(passkey)).status).toBe(201);
  const repo = mkdtempSync(join(tmpdir(), "routes-repo-"));
  Bun.spawnSync(["git", "init", "-q", repo]);
  const project = (who: typeof code, key: string, extra: object) =>
    k.call(who, "POST", "/api/orgs/acme/projects", { key, name: key, ...extra });
  expect((await (await project(code, "aa", { repo })).json()).error).toBe("step_up_required");
  expect((await project(code, "bb", {})).status).toBe(201);
  expect((await project(passkey, "cc", { repo })).status).toBe(201);
});

test("a position with a holder and a reporting line needs step-up like a manager flag", async () => {
  const k = bootApi();
  const owner = await k.user();
  const stepped = await k.user({ stepUp: true });
  const a = k.org(owner, "acme");
  k.join(a.id, stepped, "admin", "adm");
  const boss = await (
    await k.call(stepped, "POST", "/api/orgs/acme/positions", { title: "Boss" })
  ).json();
  const post = (who: typeof owner, body: object) =>
    k.call(who, "POST", "/api/orgs/acme/positions", body);
  const edge = { title: "Dev", memberId: a.owner.id, reportsTo: boss.id };
  expect((await post(owner, edge)).status).toBe(403);
  expect((await post(owner, { title: "Dev", reportsTo: boss.id })).status).toBe(201);
  expect((await post(owner, { title: "Dev2", memberId: a.owner.id })).status).toBe(201);
  expect((await post(stepped, edge)).status).toBe(201);
});

test("the org detail shows a project's repo path only to the instance admin and only for the owner org", async () => {
  const k = bootApi();
  const admin = await k.user({ admin: true });
  const plain = await k.user();
  const a = k.org(admin, "acme");
  const b = k.org(admin, "beta");
  k.join(a.id, plain, "member", "plain");
  const repo = mkdtempSync(join(tmpdir(), "routes-repo-"));
  Bun.spawnSync(["git", "init", "-q", repo]);
  const project = createProject(k.db, { orgId: a.id, key: "web", name: "Web", repo });
  grantProject(k.db, project.id, b.id, "read", a.owner.id);
  const repoSeen = async (who: typeof admin, slug: string) =>
    (await (await k.call(who, "GET", `/api/orgs/${slug}`)).json()).projects[0].repo;
  expect(await repoSeen(admin, "acme")).toBe(repo);
  expect(await repoSeen(plain, "acme")).toBeNull();
  expect(await repoSeen(admin, "beta")).toBeNull();
});
