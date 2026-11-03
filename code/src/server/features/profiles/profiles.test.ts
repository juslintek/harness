import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { bootApi } from "../../test-support/api-kit";
import { createUser } from "../auth/api";
import { addAgentMember, createOrg, getMember } from "../orgs/api";
import {
  attachProfile,
  createProfile,
  ensureProfile,
  getProfile,
  profileOfMember,
  submitCard,
} from "./api";

const validCard = {
  summary: "Ships backend features",
  specialties: ["backend", "database"],
  strengths: ["sql"],
  limits: ["no design work"],
  preferredTaskTypes: ["feature", "bugfix"],
};

const emptyInput = {
  runtime: "codex",
  model: "gpt-5",
  persona: "",
  skills: [],
  scope: { readOnly: false },
  fallbacks: [],
};

function setup(): {
  db: ReturnType<typeof openDb>;
  orgId: string;
  agentId: string;
} {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const userId = createUser(db, { email: "u@x.io", name: "U", instanceAdmin: false });
  const org = createOrg(db, {
    name: "A",
    slug: "acme",
    ownerUserId: userId,
    ownerName: "U",
    ownerHandle: "owner1",
  });
  const agent = addAgentMember(db, org.id, {
    agentId: "claude",
    model: "opus",
    handle: "bot",
    displayName: "Bot",
    specialties: [],
  });
  return { db, orgId: org.id, agentId: agent.id };
}

test("ensureProfile on an agent member creates a profile with its runtime and model", () => {
  const { db, agentId } = setup();
  const profile = ensureProfile(db, agentId);
  expect(profile).toMatchObject({ runtime: "claude", model: "opus", card: null, fallbacks: [] });
  expect(profileOfMember(db, agentId)?.id).toBe(profile.id);
  expect(ensureProfile(db, agentId).id).toBe(profile.id);
});

test("submitCard with a valid card stores it and updates members.specialties", () => {
  const { db, agentId } = setup();
  const profile = ensureProfile(db, agentId);
  const result = submitCard(db, profile.id, validCard);
  expect(result.ok).toBe(true);
  expect(getProfile(db, profile.id)?.card).toEqual(validCard as never);
  expect(getProfile(db, profile.id)?.cardAt).toBeNumber();
  expect(getMember(db, agentId)?.specialties).toEqual(["backend", "database"]);
});

test("submitCard with an unknown specialty, 9 strengths or extra key gives issues naming the path", () => {
  const { db, agentId } = setup();
  const { id } = ensureProfile(db, agentId);
  const issues = (card: unknown): string[] => {
    const r = submitCard(db, id, card);
    return r.ok ? [] : r.issues;
  };
  expect(issues({ ...validCard, specialties: ["plumbing"] })[0]).toStartWith("specialties.0:");
  const nine = Array.from({ length: 9 }, (_, i) => `s${i}`);
  expect(issues({ ...validCard, strengths: nine })[0]).toStartWith("strengths:");
  expect(issues({ ...validCard, mood: "happy" })[0]).toContain("mood");
  expect(getProfile(db, id)?.card).toBeNull();
});

test("submitCard with no specialties keeps the ones set by hand", () => {
  const { db, agentId } = setup();
  db.query("UPDATE members SET specialties = '[\"mobile\"]' WHERE id = ?").run(agentId);
  const { id } = ensureProfile(db, agentId);
  expect(submitCard(db, id, { ...validCard, specialties: [] }).ok).toBe(true);
  expect(getMember(db, agentId)?.specialties).toEqual(["mobile"]);
});

test("attachProfile copies runtime and model to the member", () => {
  const { db, orgId, agentId } = setup();
  const profile = createProfile(db, orgId, emptyInput);
  attachProfile(db, agentId, profile.id);
  expect(getMember(db, agentId)).toMatchObject({ agentId: "codex", model: "gpt-5" });
  expect(profileOfMember(db, agentId)?.id).toBe(profile.id);
});

test("PUT profile as a member role gives 403, as admin 200, and the card route answers 400 with issues", async () => {
  const k = bootApi();
  const owner = await k.user();
  const o = k.org(owner, "acme");
  const admin = await k.user();
  k.join(o.id, admin, "admin", "adm");
  const bot = addAgentMember(k.db, o.id, {
    agentId: "claude",
    handle: "bot",
    displayName: "Bot",
    specialties: [],
  });
  const url = `/api/orgs/acme/members/${bot.id}/profile`;
  const body = { ...emptyInput, fallbacks: [{ runtime: "claude", model: null }] };

  const memberWho = await k.user();
  const memberRow = k.join(o.id, memberWho, "member", "mem2");
  expect((await k.call(memberWho, "PUT", url, body)).status).toBe(403);
  expect((await k.call(memberWho, "GET", url)).status).toBe(404);

  const ok = await k.call(admin, "PUT", url, body);
  expect(ok.status).toBe(200);
  expect((await ok.json()).runtime).toBe("codex");
  expect((await (await k.call(memberWho, "GET", url)).json()).model).toBe("gpt-5");
  expect(getMember(k.db, bot.id)?.agentId).toBe("codex");

  expect((await k.call(admin, "PUT", url, { ...body, runtime: "nope" })).status).toBe(400);
  const bad = await k.call(admin, "PUT", `${url}/card`, { ...validCard, extra: 1 });
  expect(bad.status).toBe(400);
  expect((await bad.json()).issues).toHaveLength(1);
  expect((await k.call(admin, "PUT", `${url}/card`, validCard)).status).toBe(200);

  const humanUrl = `/api/orgs/acme/members/${memberRow.id}/profile`;
  const human = await k.call(admin, "PUT", humanUrl, body);
  expect(human.status).toBe(400);
  expect((await human.json()).error).toBe("not an agent member");
  expect((await k.call(admin, "PUT", `${humanUrl}/card`, validCard)).status).toBe(400);
});

test("deleting the org deletes its profiles", () => {
  const { db, orgId, agentId } = setup();
  const { id } = ensureProfile(db, agentId);
  db.query("DELETE FROM orgs WHERE id = ?").run(orgId);
  expect(getProfile(db, id)).toBeNull();
});
