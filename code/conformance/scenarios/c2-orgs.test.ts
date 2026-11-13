import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, headersFor } from "../kit/client";
import { type SeededSession, seedSession } from "../kit/seed";
import { type AgentSpec, lazyBoot } from "../kit/server";

// Orgs, members, positions, projects and grants over HTTP. Sessions are seeded, so the personal
// org a real sign-in creates is not covered here; the auth scenarios own that.

type Role = "owner" | "admin" | "member" | "viewer";
type Json = Record<string, unknown>;
interface Reply<T = Json> {
  status: number;
  body: T;
}
interface Org {
  id: string;
  slug: string;
  name: string;
  createdAt: number;
}
interface Member {
  id: string;
  userId: string | null;
  role: Role;
  [key: string]: unknown;
}
interface Row {
  id: string;
  [key: string]: unknown;
}
interface Detail {
  org: Org;
  me: Member;
  teams: Row[];
  members: Member[];
  positions: Row[];
  projects: Row[];
}

const ACTORS = [
  "owner",
  "ownerStale",
  "admin",
  "adminStale",
  "member",
  "viewer",
  "extra",
  "stranger",
  "loner",
  "keyed",
  "root",
  "rootStale",
] as const;
type Actor = (typeof ACTORS)[number];
const who = {} as Record<Actor, SeededSession>;

const stubAgent: AgentSpec = {
  id: "alpha",
  name: "Alpha",
  lane: "acp",
  bin: "/bin/echo",
  args: [],
  versionArgs: ["--version"],
  loginProbe: null,
  loginArgs: null,
  modeOption: null,
  egress: [],
  stateWrite: [],
  weakerNetworkIsolation: false,
  claudeMeta: false,
  mcp: false,
};

const lazy = lazyBoot({
  agents: [stubAgent],
  seed: (db) => {
    for (const name of ACTORS) {
      who[name] = seedSession(db, {
        admin: name.startsWith("root"),
        stepUp: !name.endsWith("Stale") && name !== "member" && name !== "viewer",
      });
    }
    // A user who already has a passkey is not pending enrollment when added to an org.
    db.query(
      "INSERT INTO passkeys (id, user_id, public_key, counter, name, created_at) VALUES ('pk1', ?, x'00', 0, 'k', 1)",
    ).run(who.keyed.userId);
  },
});
const scratch: string[] = [];
afterAll(async () => {
  try {
    await lazy.stop();
  } finally {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  }
});

const emailOf = (s: SeededSession): string => `${s.userId}@example.test`;

async function call<T = Json>(
  session: SeededSession | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<Reply<T>> {
  const res = await api(await lazy.get(), session).call(method, path, { body });
  return { status: res.status, body: (await res.json()) as T };
}

async function raw(session: SeededSession, path: string, text: string): Promise<Reply> {
  const server = await lazy.get();
  const res = await fetch(`${server.base}${path}`, {
    method: "POST",
    headers: headersFor(server, session, { "content-type": "application/json" }),
    body: text,
  });
  return { status: res.status, body: (await res.json()) as Json };
}

function expectError(reply: Reply<unknown>, status: number, error: string): void {
  expect(reply.status).toBe(status);
  expect(reply.body).toEqual({ error });
}

let counter = 0;
const slugOf = (): string => `org${++counter}`;

interface Built {
  slug: string;
  org: Org;
  m: Partial<Record<Actor, Member>>;
}

// The creator is the owner; everyone else is invited with the creator's fresh step-up.
async function mkOrg(
  roles: Partial<Record<Actor, Role>> = {},
  creator: Actor = "owner",
): Promise<Built> {
  const slug = slugOf();
  const created = await call<Org>(who[creator], "POST", "/api/orgs", { name: `Org ${slug}`, slug });
  expect(created.status).toBe(201);
  const built: Built = { slug, org: created.body, m: {} };
  for (const [name, role] of Object.entries(roles) as [Actor, Role][]) {
    const res = await call<{ member: Member }>(
      who[creator],
      "POST",
      `/api/orgs/${slug}/members/humans`,
      {
        email: emailOf(who[name]),
        role,
      },
    );
    expect(res.status).toBe(201);
    built.m[name] = res.body.member;
  }
  return built;
}

const detail = async (slug: string, as: Actor = "owner"): Promise<Detail> =>
  (await call<Detail>(who[as], "GET", `/api/orgs/${slug}`)).body;
const mid = (b: Built, name: Actor): string => (b.m[name] as Member).id;

async function mkRow(as: Actor, path: string, body: unknown): Promise<string> {
  const res = await call<Row>(who[as], "POST", path, body);
  expect(res.status).toBe(201);
  return res.body.id;
}

// Calls under one org: in(slug)("admin", "POST", "/teams", body).
const inOrg =
  (slug: string) =>
  <T = Json>(as: Actor, method: string, sub: string, body?: unknown): Promise<Reply<T>> =>
    call<T>(who[as], method, `/api/orgs/${slug}${sub}`, body);

type Route = [method: string, path: string, body: unknown, adminStatus: number];
interface Fix {
  r: Built;
  s: string;
  other: Org;
  victim: string;
  table: Route[];
}

// An org with a team, a project, a position and a plain member, plus a second org owned by a stranger.
async function fixture(creator: Actor, roles: Partial<Record<Actor, Role>>): Promise<Fix> {
  const r = await mkOrg({ ...roles, extra: "member" }, creator);
  const s = r.slug;
  const other = (
    await call<Org>(who.stranger, "POST", "/api/orgs", { name: "Other", slug: slugOf() })
  ).body;
  const teamId = (await detail(s, creator)).teams[0]?.id as string;
  const projectId = await mkRow(creator, `/api/orgs/${s}/projects`, { key: "FIX", name: "Fix" });
  const positionId = await mkRow(creator, `/api/orgs/${s}/positions`, { title: "Lead" });
  const victim = mid(r, "extra");
  const agent = { agentId: "alpha", handle: "zz", displayName: "Z" };
  const grants = `/api/projects/${projectId}/grants`;
  const base = `/api/orgs/${s}`;
  const table: Route[] = [
    ["POST", `${base}/teams`, { name: "X" }, 201],
    ["POST", `${base}/teams/${teamId}/members`, { memberId: victim }, 200],
    ["POST", `${base}/projects`, { key: "K", name: "N" }, 201],
    ["POST", `${base}/members/humans`, { email: "x@example.test", role: "viewer" }, 201],
    ["POST", `${base}/members/agents`, agent, 403],
    ["PATCH", `${base}/members/${victim}`, { paused: true }, 200],
    ["DELETE", `${base}/members/${victim}`, undefined, 200],
    ["POST", `${base}/positions`, { title: "T" }, 201],
    ["PATCH", `${base}/positions/${positionId}`, { title: "T" }, 200],
    ["POST", grants, { orgId: other.id, permission: "read" }, 200],
    ["DELETE", grants, { orgId: other.id }, 200],
  ];
  return { r, s, other, victim, table };
}

test("C2-orgs-basics: create, list and refuse duplicates [phase:2] [slice:orgs]", async () => {
  expect((await call(undefined, "GET", "/api/orgs")).status).toBe(401);
  // A seeded session never signed in, so no personal org exists for it.
  expect((await call<Org[]>(who.loner, "GET", "/api/orgs")).body).toEqual([]);

  const body = { name: "  Acme Inc  ", slug: "acme-basics" };
  const created = await call<Org>(who.owner, "POST", "/api/orgs", body);
  expect(created.status).toBe(201);
  expect(Object.keys(created.body)).toEqual(["id", "slug", "name", "createdAt"]);
  expect(created.body).toMatchObject({ slug: "acme-basics", name: "Acme Inc" });
  const slugs = async (as: Actor) => (await call<Org[]>(who[as], "GET", "/api/orgs")).body;
  expect((await slugs("owner")).find((o) => o.slug === "acme-basics")).toEqual(created.body);
  expect((await slugs("stranger")).map((o) => o.slug)).not.toContain("acme-basics");

  expectError(
    await call(who.owner, "POST", "/api/orgs", { ...body, name: "Again" }),
    409,
    "conflict",
  );
  expectError(await call(who.stranger, "GET", "/api/orgs/acme-basics"), 404, "not_found");
  expectError(await call(who.stranger, "GET", "/api/orgs/nope-nope"), 404, "not_found");
});

test("C2-orgs-basics: detail has Core, the owner and every row shape [phase:2] [slice:orgs]", async () => {
  const r = await mkOrg();
  const d = await detail(r.slug);
  expect(Object.keys(d)).toEqual(["org", "me", "teams", "members", "positions", "projects"]);
  expect(d.org).toEqual(r.org);
  expect(d.teams).toHaveLength(1);
  expect(Object.keys(d.teams[0] as Row)).toEqual(["id", "orgId", "name", "createdAt"]);
  expect(d.teams[0]).toMatchObject({ orgId: r.org.id, name: "Core" });
  expect(d.members).toEqual([d.me]);
  const keys = ["id", "orgId", "kind", "userId", "agentId", "model", "handle", "displayName"];
  expect(Object.keys(d.me)).toEqual([
    ...keys,
    ...["role", "specialties", "heartbeatMinutes", "paused", "createdAt"],
  ]);
  expect(d.me).toMatchObject({
    orgId: r.org.id,
    kind: "human",
    userId: who.owner.userId,
    agentId: null,
    model: null,
    // The handle comes from the e-mail local part, cut at 32 characters.
    handle: who.owner.userId.slice(0, 32),
    displayName: "Test",
    role: "owner",
    specialties: [],
    heartbeatMinutes: null,
    paused: false,
  });
  expect([d.positions, d.projects]).toEqual([[], []]);
});

test("C2-orgs-validation: slug, name and body shape [phase:2] [slice:orgs]", async () => {
  const post = (body: unknown) => call(who.owner, "POST", "/api/orgs", body);
  for (const slug of ["a", "-ab", "_ab", "Abc", "has space", "x".repeat(33), "", 5]) {
    expectError(await post({ name: "N", slug }), 400, "invalid body");
  }
  for (const slug of [`ab`, "a-", "0_", "x".repeat(32)]) {
    const unique = slug === "ab" ? `ab${++counter}` : slug;
    expect((await post({ name: "N", slug: unique })).status).toBe(201);
    expectError(await post({ name: "N", slug: unique }), 409, "conflict");
  }
  const ok = { name: "N", slug: "valid-slug" };
  const bad = [{}, [], null, "x", { name: "N" }, { slug: "valid-slug" }, { ...ok, extra: 1 }];
  for (const body of [...bad, { ...ok, name: "" }, { ...ok, name: "   " }, { ...ok, name: 5 }]) {
    expectError(await post(body), 400, "invalid body");
  }
  expectError(await raw(who.owner, "/api/orgs", "{not json"), 400, "invalid body");
  expectError(await raw(who.owner, "/api/orgs", ""), 400, "invalid body");
});

test("C2-orgs-validation: names are trimmed, then 1 to 80 code points [phase:2] [slice:orgs]", async () => {
  const post = (name: string) =>
    call<Org>(who.owner, "POST", "/api/orgs", { name, slug: `len-${++counter}` });
  expect((await post(` ${"n".repeat(80)} `)).body.name).toBe("n".repeat(80));
  expectError(await post("n".repeat(81)), 400, "invalid body");
  // JS trim also strips no-break, ideographic and BOM spaces.
  expect((await post("\u00a0\u3000x\ufeff\n")).body.name).toBe("x");
  // zod 4 counts code points, not UTF-16 units: 80 emoji are 160 units and still fit.
  expect((await post("\u{1F600}".repeat(80))).status).toBe(201);
  expectError(await post("\u{1F600}".repeat(81)), 400, "invalid body");
  // A combining mark is a code point of its own.
  expect((await post("e\u0301".repeat(40))).status).toBe(201);
  expectError(await post("e\u0301".repeat(41)), 400, "invalid body");
});

test("C2-orgs-tenant: a non-member gets 404 on every org and project route [phase:2] [slice:orgs]", async () => {
  const f = await fixture("root", { owner: "owner" });
  const routes: Route[] = [["GET", `/api/orgs/${f.s}`, undefined, 200], ...f.table];
  // The instance admin is no exception; nor are another org's owner, a stale admin or an org-less user.
  for (const as of ["stranger", "loner", "rootStale", "adminStale"] as const) {
    for (const [method, path, body] of routes) {
      expectError(await call(who[as], method, path, body), 404, "not_found");
      // A bad body must not leak that the org exists.
      if (method !== "GET") {
        expectError(await call(who[as], method, path, { bogus: true }), 404, "not_found");
      }
    }
  }
  for (const [method, path, body] of routes.slice(0, 10)) {
    const unknown = path.replace(f.s, "no-such-org");
    expectError(await call(who.stranger, method, unknown, body), 404, "not_found");
  }
  const after = await detail(f.s, "root");
  expect(after.members).toHaveLength(3);
  expect([after.teams, after.projects, after.positions].map((rows) => rows.length)).toEqual([
    1, 1, 1,
  ]);
});

test("C2-orgs-roles: member and viewer are refused before the body is read [phase:2] [slice:orgs]", async () => {
  const f = await fixture("owner", { admin: "admin", member: "member", viewer: "viewer" });
  for (const as of ["member", "viewer"] as const) {
    expect((await call<Detail>(who[as], "GET", `/api/orgs/${f.s}`)).body.me.role).toBe(as);
    for (const [method, path, body] of f.table) {
      expectError(await call(who[as], method, path, body), 403, "forbidden");
      expectError(await call(who[as], method, path, { bogus: true }), 403, "forbidden");
    }
  }
});

test("C2-orgs-roles: an admin may use every mutating route but agents [phase:2] [slice:orgs]", async () => {
  const f = await fixture("owner", { admin: "admin" });
  for (const [method, path, body, status] of f.table) {
    const reply = await call(who.admin, method, path, body);
    expect(reply.status).toBe(status);
    if (status === 403) expect(reply.body).toEqual({ error: "forbidden" });
  }
});

const memberOps = (s: string) => {
  const send = inOrg(s);
  return {
    patch: (as: Actor, id: string, body: unknown) =>
      send<Member>(as, "PATCH", `/members/${id}`, body),
    del: (as: Actor, id: string) => send(as, "DELETE", `/members/${id}`),
  };
};

test("C2-orgs-ownership: only an owner moves ownership, never the last one [phase:2] [slice:orgs]", async () => {
  const r = await mkOrg({ admin: "admin", member: "member" });
  const { patch, del } = memberOps(r.slug);
  const ownerId = (await detail(r.slug)).me.id;
  expectError(await patch("owner", ownerId, { role: "admin" }), 409, "last_owner");
  expectError(await del("owner", ownerId), 409, "last_owner");
  expectError(await patch("admin", mid(r, "member"), { role: "owner" }), 403, "forbidden");
  expectError(await patch("admin", ownerId, { role: "member" }), 403, "forbidden");
  expectError(await del("admin", ownerId), 403, "forbidden");
  // Only a role change is guarded: other fields of an owner stay open to an admin.
  expect((await patch("admin", ownerId, { paused: true })).status).toBe(200);

  const send = inOrg(r.slug);
  const second = await send<{ member: Member }>("owner", "POST", "/members/humans", {
    email: emailOf(who.ownerStale),
    role: "owner",
  });
  expect(second.status).toBe(201);
  const secondId = second.body.member.id;
  expectError(await patch("ownerStale", ownerId, { role: "admin" }), 403, "step_up_required");
  expect((await patch("owner", ownerId, { role: "admin" })).body.role).toBe("admin");
  expectError(await patch("ownerStale", secondId, { role: "admin" }), 409, "last_owner");
  expectError(await del("ownerStale", secondId), 409, "last_owner");
});

test("C2-orgs-ownership: role changes and removals of admins need a step-up [phase:2] [slice:orgs]", async () => {
  const r = await mkOrg({
    admin: "admin",
    adminStale: "admin",
    member: "member",
    viewer: "viewer",
  });
  const { patch, del } = memberOps(r.slug);
  const member = mid(r, "member");
  // Ownership checks run before the step-up check.
  expectError(await patch("adminStale", member, { role: "owner" }), 403, "forbidden");
  expectError(await patch("adminStale", member, { role: "admin" }), 403, "step_up_required");
  expect((await patch("adminStale", member, { displayName: "Kept" })).status).toBe(200);
  expect((await patch("adminStale", member, { role: "member" })).status).toBe(200);
  expect((await patch("admin", member, { role: "admin" })).body.role).toBe("admin");
  expectError(await del("adminStale", member), 403, "step_up_required");
  expect((await del("admin", member)).body).toEqual({ ok: true });
  // Removing a viewer needs none.
  expect((await del("adminStale", mid(r, "viewer"))).body).toEqual({ ok: true });
  expectError(await del("adminStale", mid(r, "viewer")), 404, "not_found");
});

test("C2-orgs-humans: a new address gets a link, lowercased and trimmed [phase:2] [slice:orgs]", async () => {
  const r = await mkOrg({ admin: "admin" });
  const send = inOrg(r.slug);
  type Invite = { member: Member } & Json;
  const invite = (body: unknown) => send<Invite>("admin", "POST", "/members/humans", body);
  const fresh = await invite({ email: "  New.Person+X@Example.TEST ", role: "viewer" });
  expect(fresh.status).toBe(201);
  expect(Object.keys(fresh.body)).toEqual(["member", "enrollmentLink"]);
  const origin = new URL((await lazy.get()).origin).origin;
  const code = "[a-z2-7]{4}(-[a-z2-7]{4}){3}";
  expect(fresh.body.enrollmentLink).toMatch(new RegExp(`^${origin}/#/enroll/${code}$`));
  expect(fresh.body.member).toMatchObject({
    kind: "human",
    role: "viewer",
    handle: "new-person-x",
    displayName: "new.person+x",
    agentId: null,
  });
  // The address was stored lowercase, so the same person in another case is a duplicate member.
  expectError(
    await invite({ email: "NEW.person+x@example.test", role: "member" }),
    409,
    "conflict",
  );
  const named = { email: "pat@example.test", role: "member", name: "  Pat  ", handle: "pat-h" };
  expect((await invite(named)).body.member).toMatchObject({ displayName: "Pat", handle: "pat-h" });
  expectError(await invite({ ...named, email: "pat2@example.test" }), 409, "conflict");
});

test("C2-orgs-humans: an existing user is added without a link [phase:2] [slice:orgs]", async () => {
  const r = await mkOrg({ admin: "admin" });
  const send = inOrg(r.slug);
  const invite = (email: string) =>
    send<{ member: Member } & Json>("admin", "POST", "/members/humans", { email, role: "member" });
  // With no passkey yet the user is pending enrollment; reissuing a link stays with the instance admin.
  const pending = await invite(emailOf(who.extra));
  expect(Object.keys(pending.body)).toEqual(["member", "enrollmentLink", "pendingEnrollment"]);
  expect(pending.body).toMatchObject({ enrollmentLink: null, pendingEnrollment: true });
  expect(pending.body.member).toMatchObject({
    userId: who.extra.userId,
    displayName: "Test",
    handle: who.extra.userId.slice(0, 32),
  });
  const keyed = await invite(emailOf(who.keyed).toUpperCase());
  expect(Object.keys(keyed.body)).toEqual(["member", "enrollmentLink"]);
  expect(keyed.body.enrollmentLink).toBeNull();
});

test("C2-orgs-humans: bodies, owner invites and the step-up for admins [phase:2] [slice:orgs]", async () => {
  const r = await mkOrg({ admin: "admin", adminStale: "admin" });
  const send = inOrg(r.slug);
  const invite = (as: Actor, email: string, role: string, more: Json = {}) =>
    send<{ enrollmentLink: string | null } & Json>(as, "POST", "/members/humans", {
      email,
      role,
      ...more,
    });
  const ok = "ok@example.test";
  const bodies = [
    { email: "nope", role: "member" },
    { email: `${"a".repeat(250)}@example.test`, role: "member" },
    { email: ok, role: "boss" },
    { email: ok },
    { role: "member" },
    { email: ok, role: "member", handle: "A" },
    { email: ok, role: "member", name: "" },
    { email: ok, role: "member", extra: 1 },
  ];
  for (const body of bodies)
    expectError(await send("admin", "POST", "/members/humans", body), 400, "invalid body");

  expectError(await invite("admin", "own@example.test", "owner"), 403, "forbidden");
  expect((await invite("owner", "own@example.test", "owner")).status).toBe(201);
  expectError(await invite("adminStale", "adm@example.test", "admin"), 403, "step_up_required");
  expect((await invite("adminStale", "mem@example.test", "member")).status).toBe(201);
  expect((await invite("admin", "adm@example.test", "admin")).status).toBe(201);
  // A refused invite leaves no half-made user: the address is still new afterwards.
  expectError(await invite("adminStale", "late@example.test", "admin"), 403, "step_up_required");
  expect((await invite("admin", "late@example.test", "admin")).body.enrollmentLink).toBeTruthy();
});

const agentBase = { agentId: "alpha", handle: "bot", displayName: "Bot" };

test("C2-orgs-agents: only the instance admin adds one, with a step-up [phase:2] [slice:orgs]", async () => {
  const r = await mkOrg({ admin: "admin", rootStale: "owner" }, "root");
  const send = inOrg(r.slug);
  const add = (as: Actor, body: unknown) => send<Member>(as, "POST", "/members/agents", body);
  expectError(await add("admin", {}), 403, "forbidden");
  expectError(await add("rootStale", {}), 403, "step_up_required");
  expectError(await add("root", { ...agentBase, agentId: "nope" }), 400, "unknown agent");

  const made = await add("root", agentBase);
  expect(made.status).toBe(201);
  expect(Object.keys(made.body)).toEqual(Object.keys((await detail(r.slug, "root")).me));
  expect(made.body).toMatchObject({
    kind: "agent",
    userId: null,
    agentId: "alpha",
    model: null,
    handle: "bot",
    displayName: "Bot",
    role: "member",
    specialties: [],
    heartbeatMinutes: null,
    paused: false,
  });
  const more = { handle: "bot-2", model: "m1", specialties: ["a", "b"], heartbeatMinutes: 60 };
  expect((await add("root", { ...agentBase, ...more })).body).toMatchObject(more);
  expectError(await add("root", agentBase), 409, "conflict");
});

test("C2-orgs-agents: body limits, JSON 5.0 is an integer [phase:2] [slice:orgs]", async () => {
  const r = await mkOrg({}, "root");
  const add = (body: unknown) => inOrg(r.slug)<Member>("root", "POST", "/members/agents", body);
  const five = '{"agentId":"alpha","handle":"five","displayName":"F","heartbeatMinutes":5.0}';
  const reply = await raw(who.root, `/api/orgs/${r.slug}/members/agents`, five);
  expect(reply.status).toBe(201);
  expect(reply.body.heartbeatMinutes).toBe(5);
  expect((await add({ ...agentBase, heartbeatMinutes: 10080 })).status).toBe(201);
  expect(
    (await add({ ...agentBase, handle: "s20", specialties: Array(20).fill("s") })).status,
  ).toBe(201);
  const invalid: Json[] = [
    { heartbeatMinutes: 1.5 },
    { heartbeatMinutes: 0 },
    { heartbeatMinutes: 10081 },
    { heartbeatMinutes: "5" },
    { specialties: Array(21).fill("s") },
    { specialties: [""] },
    { specialties: ["x".repeat(41)] },
    { model: "" },
    { model: "m".repeat(121) },
    { handle: "Bad Handle" },
    { displayName: "" },
    { agentId: "" },
    { agentId: "a".repeat(65) },
    { unknown: 1 },
  ];
  for (const extra of invalid) {
    expectError(await add({ ...agentBase, handle: "other", ...extra }), 400, "invalid body");
  }
});

test("C2-orgs-agents: agents cannot be admins, and members can be patched and removed [phase:2] [slice:orgs]", async () => {
  const r = await mkOrg({ admin: "admin", rootStale: "owner" }, "root");
  const { patch, del } = memberOps(r.slug);
  const agent = await inOrg(r.slug)<Member>("root", "POST", "/members/agents", agentBase);
  const id = agent.body.id;
  // The step-up check comes before the role rule.
  expectError(await patch("rootStale", id, { role: "admin" }), 403, "step_up_required");
  expectError(await patch("root", id, { role: "admin" }), 400, "agents cannot be admins");
  expectError(await patch("root", id, { role: "owner" }), 400, "agents cannot be admins");
  expect((await patch("root", id, { role: "viewer" })).body.role).toBe("viewer");
  const change = {
    displayName: " New ",
    model: null,
    specialties: ["z"],
    heartbeatMinutes: null,
    paused: true,
  };
  const changed = await patch("admin", id, change);
  expect(changed.body).toMatchObject({ ...change, displayName: "New", role: "viewer" });
  expect((await patch("admin", id, {})).body).toEqual(changed.body);
  expectError(await patch("admin", id, { heartbeatMinutes: 0 }), 400, "invalid body");
  expectError(await patch("admin", "no-such-member", { paused: false }), 404, "not_found");
  const foreign = await detail((await mkOrg({}, "root")).slug, "root");
  expectError(await patch("admin", foreign.me.id, { paused: true }), 404, "not_found");
  expect((await del("admin", id)).body).toEqual({ ok: true });
  expectError(await del("admin", id), 404, "not_found");
});

test("C2-orgs-teams: create, add members and refuse foreign ones [phase:2] [slice:orgs]", async () => {
  const r = await mkOrg({ admin: "admin", member: "member" });
  const send = inOrg(r.slug);
  const other = await detail((await mkOrg({}, "root")).slug, "root");
  const team = await send<Row>("admin", "POST", "/teams", { name: " Ops " });
  expect(Object.keys(team.body)).toEqual(["id", "orgId", "name", "createdAt"]);
  expect(team.body.name).toBe("Ops");
  expectError(await send("admin", "POST", "/teams", { name: "Ops" }), 409, "conflict");
  const add = (teamId: unknown, memberId: unknown) =>
    send("admin", "POST", `/teams/${teamId}/members`, { memberId });
  expect((await add(team.body.id, mid(r, "member"))).body).toEqual({ ok: true });
  expect((await add(team.body.id, mid(r, "member"))).body).toEqual({ ok: true });
  expectError(await add(team.body.id, other.me.id), 400, "member not in org");
  expectError(await add(team.body.id, "m".repeat(65)), 400, "invalid body");
  expectError(await add("nope", mid(r, "member")), 404, "not_found");
  expectError(await add(other.teams[0]?.id, mid(r, "member")), 404, "not_found");
});

test("C2-orgs-positions: refs stay in the org and reporting lines have no cycles [phase:2] [slice:orgs]", async () => {
  const r = await mkOrg({ admin: "admin", member: "member" });
  const send = inOrg(r.slug);
  const other = await mkOrg({}, "root");
  const foreign = await detail(other.slug, "root");
  const theirs = await mkRow("root", `/api/orgs/${other.slug}/positions`, { title: "Theirs" });
  const pos = (body: unknown) => send<Row>("admin", "POST", "/positions", body);
  const patch = (id: string, body: unknown) =>
    send<Row>("admin", "PATCH", `/positions/${id}`, body);
  const lead = await pos({ title: " Lead " });
  expect(Object.keys(lead.body)).toEqual([
    "id",
    "orgId",
    "teamId",
    "title",
    "memberId",
    "reportsTo",
    "isManager",
    "createdAt",
  ]);
  expect(lead.body).toMatchObject({
    title: "Lead",
    teamId: null,
    memberId: null,
    reportsTo: null,
    isManager: false,
  });
  const rep = await pos({ title: "Rep", reportsTo: lead.body.id });
  const ref = "team or member not in org";
  expectError(await pos({ title: "X", teamId: foreign.teams[0]?.id }), 400, ref);
  expectError(await pos({ title: "X", memberId: foreign.me.id }), 400, ref);
  expectError(await pos({ title: "X", teamId: "nope" }), 400, ref);
  const line = "reports_to must be a position in the same org";
  expectError(await pos({ title: "X", reportsTo: theirs }), 400, line);
  expectError(await pos({ title: "X", reportsTo: "nope" }), 400, line);
  expectError(await patch(lead.body.id, { reportsTo: theirs }), 400, line);
  expectError(await patch(lead.body.id, { teamId: foreign.teams[0]?.id }), 400, ref);
  expectError(
    await patch(lead.body.id, { reportsTo: rep.body.id }),
    400,
    "reports_to would create a cycle",
  );
  expectError(
    await patch(lead.body.id, { reportsTo: lead.body.id }),
    400,
    "reports_to would create a cycle",
  );
  expect((await patch(rep.body.id, { reportsTo: null })).body.reportsTo).toBeNull();
});

test("C2-orgs-positions: bodies and unknown ids [phase:2] [slice:orgs]", async () => {
  const r = await mkOrg({ admin: "admin" });
  const send = inOrg(r.slug);
  const id = await mkRow("owner", `/api/orgs/${r.slug}/positions`, { title: "P" });
  const bodies = [
    {},
    { title: "" },
    { title: "x".repeat(81) },
    { title: "X", isManager: "yes" },
    { title: "X", extra: 1 },
  ];
  for (const body of bodies)
    expectError(await send("admin", "POST", "/positions", body), 400, "invalid body");
  expect((await send("admin", "POST", "/positions", { title: "x".repeat(80) })).status).toBe(201);
  const other = await mkRow("root", `/api/orgs/${(await mkOrg({}, "root")).slug}/positions`, {
    title: "T",
  });
  // The position is looked up before the body is read.
  expectError(await send("admin", "PATCH", "/positions/nope", { bogus: 1 }), 404, "not_found");
  expectError(
    await send("admin", "PATCH", `/positions/${other}`, { title: "x" }),
    404,
    "not_found",
  );
  expectError(await send("admin", "PATCH", `/positions/${id}`, { bogus: 1 }), 400, "invalid body");
});

test("C2-orgs-positions: manager authority needs a step-up on create [phase:2] [slice:orgs]", async () => {
  const r = await mkOrg({ admin: "admin", adminStale: "admin", member: "member" });
  const send = inOrg(r.slug);
  const pos = (as: Actor, body: unknown) => send<Row>(as, "POST", "/positions", body);
  const lead = (await pos("adminStale", { title: "Lead" })).body.id;
  const holder = mid(r, "member");
  const denied = "step_up_required";
  expectError(await pos("adminStale", { title: "Boss", isManager: true }), 403, denied);
  expectError(
    await pos("adminStale", { title: "Rep", memberId: holder, reportsTo: lead }),
    403,
    denied,
  );
  // A holder alone, or a reporting line alone, widens nothing.
  expect((await pos("adminStale", { title: "Holder", memberId: holder })).status).toBe(201);
  const line = await pos("adminStale", { title: "Line", reportsTo: lead });
  expect(line.body).toMatchObject({ reportsTo: lead });
  const rep = await pos("admin", {
    title: "Rep",
    memberId: holder,
    reportsTo: lead,
    isManager: true,
  });
  expect(rep.body).toMatchObject({ memberId: holder, reportsTo: lead, isManager: true });
});

test("C2-orgs-positions: only a change of manager, holder or line needs a step-up on patch [phase:2] [slice:orgs]", async () => {
  const r = await mkOrg({ admin: "admin", adminStale: "admin", member: "member" });
  const send = inOrg(r.slug);
  const holder = mid(r, "member");
  const lead = await mkRow("admin", `/api/orgs/${r.slug}/positions`, { title: "Lead" });
  const rep = await mkRow("admin", `/api/orgs/${r.slug}/positions`, {
    title: "Rep",
    reportsTo: lead,
  });
  const patch = (as: Actor, id: string, body: unknown) =>
    send<Row>(as, "PATCH", `/positions/${id}`, body);
  const same = { title: "Chief", isManager: false, memberId: null, reportsTo: null, teamId: null };
  expect((await patch("adminStale", lead, same)).body).toMatchObject({ title: "Chief" });
  for (const change of [{ isManager: true }, { memberId: holder }, { reportsTo: rep }]) {
    expectError(await patch("adminStale", lead, change), 403, "step_up_required");
  }
  expect((await patch("admin", lead, { isManager: true, memberId: holder })).body).toMatchObject({
    isManager: true,
    memberId: holder,
  });
  expect((await patch("adminStale", lead, { isManager: true, memberId: holder })).status).toBe(200);
  expectError(await patch("adminStale", rep, { reportsTo: null }), 403, "step_up_required");
  expect((await patch("admin", rep, { reportsTo: null })).body.reportsTo).toBeNull();
});

test("C2-orgs-projects: keys, names and teams [phase:2] [slice:orgs]", async () => {
  const r = await mkOrg({ admin: "admin" });
  const send = inOrg(r.slug);
  const post = (body: unknown) => send<Row>("admin", "POST", "/projects", body);
  const plain = await post({ key: "A_b-1", name: " Plain " });
  expect(plain.status).toBe(201);
  expect(Object.keys(plain.body)).toEqual([
    "id",
    "orgId",
    "teamId",
    "key",
    "name",
    "repo",
    "createdAt",
  ]);
  expect(plain.body).toMatchObject({
    orgId: r.org.id,
    teamId: null,
    key: "A_b-1",
    name: "Plain",
    repo: null,
  });
  expectError(await post({ key: "A_b-1", name: "Dup" }), 409, "conflict");
  expect((await post({ key: "k".repeat(16), name: "Long" })).status).toBe(201);
  for (const key of ["", "k".repeat(17), "a b", "a/b", 5])
    expectError(await post({ key, name: "N" }), 400, "invalid body");
  const bodies = [
    { key: "X" },
    { name: "N" },
    { key: "X", name: "N", extra: 1 },
    { key: "X", name: "" },
  ];
  for (const body of bodies) expectError(await post(body), 400, "invalid body");
  const team = (await detail(r.slug)).teams[0]?.id;
  expect((await post({ key: "T1", name: "N", teamId: team })).body).toMatchObject({ teamId: team });
  const foreign = (await detail((await mkOrg({}, "root")).slug, "root")).teams[0]?.id;
  expectError(await post({ key: "T2", name: "N", teamId: foreign }), 400, "team not in org");
  expectError(await post({ key: "T2", name: "N", teamId: "nope" }), 400, "team not in org");
});

const tempDir = (git: boolean): string => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "harness-orgs-")));
  scratch.push(path);
  if (git) expect(Bun.spawnSync(["git", "init", "-q", path]).exitCode).toBe(0);
  return path;
};

test("C2-orgs-projects: a repo path is the instance admin's, with a step-up, and must be a git repo [phase:2] [slice:orgs]", async () => {
  const r = await mkOrg({ admin: "admin", rootStale: "admin" }, "root");
  const post = (as: Actor, repo: unknown) =>
    inOrg(r.slug)<Row>(as, "POST", "/projects", { key: "R1", name: "N", repo });
  // The body is validated first, then who may set a path, then the path itself.
  expectError(await post("admin", ""), 400, "invalid body");
  expectError(await post("admin", "/".padEnd(1025, "x")), 400, "invalid body");
  expectError(await post("admin", tempDir(true)), 403, "forbidden");
  expectError(await post("rootStale", tempDir(true)), 403, "step_up_required");
  expectError(
    await post("root", "relative/path"),
    400,
    "repo must be an absolute path: relative/path",
  );
  const plain = tempDir(false);
  expectError(await post("root", plain), 400, `not a git repo: ${plain}`);
  expectError(await post("root", `${plain}/missing`), 400, `not a git repo: ${plain}/missing`);
  expect((await detail(r.slug, "root")).projects).toEqual([]);

  const repo = tempDir(true);
  const made = await post("root", repo);
  expect(made.status).toBe(201);
  expect(made.body.repo).toBe(repo);
  const repoOf = async (as: Actor) => (await detail(r.slug, as)).projects[0]?.repo;
  expect(await repoOf("root")).toBe(repo);
  expect(await repoOf("admin")).toBeNull();
});

test("C2-orgs-projects: even the instance admin sees no repo of another org's project [phase:2] [slice:orgs]", async () => {
  const host = await mkOrg({}, "root");
  const guest = await mkOrg({}, "root");
  const repo = tempDir(true);
  const made = await inOrg(host.slug)<Row>("root", "POST", "/projects", {
    key: "H1",
    name: "N",
    repo,
  });
  const grant = { orgId: guest.org.id, permission: "read" };
  expect((await call(who.root, "POST", `/api/projects/${made.body.id}/grants`, grant)).status).toBe(
    200,
  );
  const seen = (await detail(guest.slug, "root")).projects;
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ id: made.body.id, orgId: host.org.id, repo: null });
  expect((await detail(host.slug, "root")).projects[0]?.repo).toBe(repo);
});

test("C2-orgs-grants: who may act is settled before the body is read [phase:2] [slice:orgs]", async () => {
  const a = await mkOrg({ admin: "admin", adminStale: "admin", member: "member" });
  const b = await mkOrg({ extra: "member" }, "stranger");
  const id = await mkRow("owner", `/api/orgs/${a.slug}/projects`, { key: "SHR", name: "Shared" });
  const path = `/api/projects/${id}/grants`;
  const grant = (as: Actor, body: unknown) => call(who[as], "POST", path, body);
  const revoke = (as: Actor, body: unknown) => call(who[as], "DELETE", path, body);
  const read = { orgId: b.org.id, permission: "read" };
  expectError(await call(who.owner, "POST", "/api/projects/nope/grants", read), 404, "not_found");
  expectError(await grant("stranger", { bogus: 1 }), 404, "not_found");
  expectError(await grant("loner", { bogus: 1 }), 404, "not_found");
  expectError(await grant("member", { bogus: 1 }), 403, "forbidden");
  expectError(await grant("adminStale", { bogus: 1 }), 403, "step_up_required");
  expectError(await revoke("adminStale", { orgId: b.org.id }), 403, "step_up_required");
  expect((await detail(b.slug, "stranger")).projects).toEqual([]);
  // The grantee org's own members never manage grants: 404 before a grant exists, 403 after.
  expectError(await grant("stranger", read), 404, "not_found");
  expect((await grant("admin", read)).status).toBe(200);
  expectError(await grant("stranger", { orgId: a.org.id, permission: "read" }), 403, "forbidden");
  expectError(await revoke("extra", { orgId: b.org.id }), 403, "forbidden");
  expect((await revoke("admin", { orgId: b.org.id })).status).toBe(200);
  expectError(await revoke("stranger", { orgId: b.org.id }), 404, "not_found");
});

test("C2-orgs-grants: grant, update, revoke and the org that sees the project [phase:2] [slice:orgs]", async () => {
  const a = await mkOrg({ admin: "admin" });
  const b = await mkOrg({}, "stranger");
  const id = await mkRow("owner", `/api/orgs/${a.slug}/projects`, { key: "SHR", name: "Shared" });
  const path = `/api/projects/${id}/grants`;
  const grant = (body: unknown) => call(who.admin, "POST", path, body);
  const revoke = (body: unknown) => call(who.admin, "DELETE", path, body);
  expectError(await grant({ orgId: "no-such-org", permission: "read" }), 400, "invalid org");
  expectError(await grant({ orgId: a.org.id, permission: "read" }), 400, "invalid org");
  const invalid = [
    { orgId: b.org.id },
    { permission: "read" },
    { orgId: b.org.id, permission: "admin" },
    { orgId: b.org.id, permission: "read", extra: 1 },
    { orgId: "", permission: "read" },
  ];
  for (const body of invalid) expectError(await grant(body), 400, "invalid body");
  expectError(await revoke({ orgId: b.org.id, permission: "read" }), 400, "invalid body");
  expectError(await revoke({}), 400, "invalid body");

  expect((await grant({ orgId: b.org.id, permission: "read" })).body).toEqual({ ok: true });
  expect((await grant({ orgId: b.org.id, permission: "write" })).body).toEqual({ ok: true });
  const seen = (await detail(b.slug, "stranger")).projects;
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ id, orgId: a.org.id, key: "SHR", repo: null });
  expect((await revoke({ orgId: b.org.id })).body).toEqual({ ok: true });
  expect((await revoke({ orgId: b.org.id })).body).toEqual({ ok: true });
  expect((await detail(b.slug, "stranger")).projects).toEqual([]);
});

test("C2-orgs-strict: an unknown key or a wrong JSON type is refused on every route [phase:2] [slice:orgs]", async () => {
  const f = await fixture("root", {});
  const routes: Route[] = [
    ["POST", "/api/orgs", { name: "N", slug: "strict-org" }, 201],
    ...f.table,
  ];
  for (const [method, path, body] of routes) {
    if (body === undefined) continue;
    const extra = { ...(body as Json), extra: 1 };
    expectError(await call(who.root, method, path, extra), 400, "invalid body");
    for (const bad of [null, [], "text", 7]) {
      expectError(await call(who.root, method, path, bad), 400, "invalid body");
    }
  }
  // The same bodies without the extra key are accepted, so the 400s above came from the key.
  for (const [method, path, body] of routes) {
    expect((await call(who.root, method, path, body)).status).toBeLessThan(300);
  }
});

// std.json reads a string field from an array of byte integers and an enum from a number; zod
// answers 400 for both, so the Zig server must too.
test("C2-orgs-validation: loose strings and numeric enums are refused [phase:2] [slice:orgs]", async () => {
  const bytes = (text: string) => [...Buffer.from(text)];
  const r = await mkOrg({ admin: "admin" });
  const send = inOrg(r.slug);
  const org = (body: unknown) => call(who.owner, "POST", "/api/orgs", body);
  expectError(await org({ name: bytes("Acme"), slug: "bytes-name" }), 400, "invalid body");
  expectError(await org({ name: "Acme", slug: bytes("bytes-slug") }), 400, "invalid body");
  expectError(await send("admin", "POST", "/teams", { name: bytes("Core") }), 400, "invalid body");
  const email = "loose@example.test";
  const people = [
    { email: bytes(email), role: "member" },
    { email, role: 1 },
    { email, role: 0 },
    { email, role: "member", name: bytes("Loose") },
  ];
  for (const body of people)
    expectError(await send("admin", "POST", "/members/humans", body), 400, "invalid body");
  expectError(
    await send("admin", "POST", "/positions", { title: bytes("P") }),
    400,
    "invalid body",
  );
  const other = await mkOrg({}, "root");
  const made = await mkRow("owner", `/api/orgs/${r.slug}/projects`, { key: "L1", name: "N" });
  const grants = `/api/projects/${made}/grants`;
  for (const permission of [0, 1, bytes("read")])
    expectError(
      await call(who.owner, "POST", grants, { orgId: other.org.id, permission }),
      400,
      "invalid body",
    );
  expectError(
    await call(who.owner, "POST", grants, { orgId: bytes("x"), permission: "read" }),
    400,
    "invalid body",
  );
});
