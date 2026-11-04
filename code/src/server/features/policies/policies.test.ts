import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { bootApi } from "../../test-support/api-kit";
import {
  addAgentMember,
  addToTeam,
  createOrg,
  createPosition,
  listTeams,
  type MemberRow,
} from "../orgs/api";
import {
  contextForMember,
  decideProposal,
  effective,
  explain,
  listProposals,
  onProposalChange,
  propose,
  review,
  setPolicy,
} from "./api";

function world() {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const org = createOrg(db, {
    name: "A",
    slug: "aa",
    ownerUserId: "u1",
    ownerName: "O",
    ownerHandle: "owner",
  });
  const team = listTeams(db, org.id)[0]?.id as string;
  const agent = (handle: string): MemberRow =>
    addAgentMember(db, org.id, { agentId: "claude", handle, displayName: handle, specialties: [] });
  return { db, org, team, agent };
}

const setBy = "test";

test("default autonomy is full with layer default", () => {
  const { db, org } = world();
  expect(effective(db, { orgId: org.id }, "autonomy")).toMatchObject({
    value: "full",
    layer: "default",
    targetId: null,
    chain: [],
  });
});

test("org sets hiring.decision human, team sets auto → member in the team sees auto from layer team, chain lists both", () => {
  const { db, org, team, agent } = world();
  const dev = agent("dev");
  addToTeam(db, team, dev.id);
  const put = (layer: "org" | "team", targetId: string, value: string) =>
    setPolicy(db, { layer, targetId, key: "hiring.decision", value, setBy });
  expect(put("org", org.id, "human")).toEqual({ ok: true });
  expect(put("team", team, "auto")).toEqual({ ok: true });
  const ctx = contextForMember(db, dev.id);
  expect(ctx.teamId).toBe(team);
  const got = effective(db, ctx, "hiring.decision");
  expect(got).toMatchObject({ value: "auto", layer: "team", targetId: team });
  expect(got.chain.map((r) => r.layer)).toEqual(["org", "team"]);
  expect(explain(db, ctx)).toHaveLength(6);
});

test("org autonomy strict, agent row full (inserted directly) → effective strict from org", () => {
  const { db, org, agent } = world();
  const dev = agent("dev");
  setPolicy(db, { layer: "org", targetId: org.id, key: "autonomy", value: "strict", setBy });
  db.run(
    "INSERT INTO policies (id, layer, target_id, key, value, set_by, updated_at) VALUES ('p', 'agent', ?, 'autonomy', '\"full\"', 'x', 1)",
    [dev.id],
  );
  const got = effective(db, contextForMember(db, dev.id), "autonomy");
  expect(got).toMatchObject({ value: "strict", layer: "org" });
  expect(got.chain).toHaveLength(2);
});

test("setPolicy agent autonomy full under org supervised → refused looser than org", () => {
  const { db, org, agent } = world();
  const dev = agent("dev");
  setPolicy(db, { layer: "org", targetId: org.id, key: "autonomy", value: "supervised", setBy });
  const result = setPolicy(db, {
    layer: "agent",
    targetId: dev.id,
    key: "autonomy",
    value: "full",
    setBy,
  });
  expect(result).toEqual({ ok: false, reason: "looser than org" });
  expect(
    setPolicy(db, { layer: "agent", targetId: dev.id, key: "autonomy", value: "strict", setBy }),
  ).toEqual({ ok: true });
});

test("setPolicy with an invalid value → refused", () => {
  const { db, org } = world();
  const bad = (key: "autonomy" | "heartbeat.maxRunsPerHour", value: unknown) =>
    setPolicy(db, { layer: "org", targetId: org.id, key, value, setBy });
  expect(bad("autonomy", "wild")).toEqual({ ok: false, reason: "invalid value" });
  expect(bad("heartbeat.maxRunsPerHour", 0)).toEqual({ ok: false, reason: "invalid value" });
  expect(bad("heartbeat.maxRunsPerHour", 1.5).ok).toBe(false);
});

// A manager agent above a worker agent, the worker holding a strict autonomy of its own.
function managed() {
  const w = world();
  const boss = w.agent("boss");
  const dev = w.agent("dev");
  const top = createPosition(w.db, {
    orgId: w.org.id,
    title: "lead",
    memberId: boss.id,
    isManager: true,
  });
  createPosition(w.db, { orgId: w.org.id, title: "dev", memberId: dev.id, reportsTo: top.id });
  setPolicy(w.db, { layer: "agent", targetId: dev.id, key: "autonomy", value: "strict", setBy });
  return { ...w, boss, dev };
}

test("propose loosening autonomy, agent manager decides approve → refused; human decides approve → applied", () => {
  const { db, org, boss, dev } = managed();
  const p = propose(db, {
    orgId: org.id,
    memberId: dev.id,
    key: "autonomy",
    value: "full",
    reason: "trusted",
    reviewers: [boss.id],
  });
  const byBoss = decideProposal(db, {
    proposalId: p.id,
    decidedBy: { kind: "agent", memberId: boss.id },
    decision: "approve",
    reason: "",
  });
  expect(byBoss.ok).toBe(false);
  expect(effective(db, contextForMember(db, dev.id), "autonomy").value).toBe("strict");
  const byHuman = decideProposal(db, {
    proposalId: p.id,
    decidedBy: { kind: "human", userId: "u1" },
    decision: "approve",
    reason: "ok",
  });
  expect(byHuman).toEqual({ ok: true });
  expect(effective(db, contextForMember(db, dev.id), "autonomy").value).toBe("full");
  expect(listProposals(db, org.id, "approved")).toHaveLength(1);
});

test("an agent manager may approve tightening, an unrelated agent may decide nothing", () => {
  const { db, org, boss, dev, agent } = managed();
  setPolicy(db, { layer: "agent", targetId: dev.id, key: "autonomy", value: "full", setBy });
  const p = propose(db, {
    orgId: org.id,
    memberId: dev.id,
    key: "autonomy",
    value: "supervised",
    reason: "careful",
    reviewers: [],
  });
  const stranger = agent("stranger");
  const decide = (memberId: string) =>
    decideProposal(db, {
      proposalId: p.id,
      decidedBy: { kind: "agent", memberId },
      decision: "approve",
      reason: "",
    });
  expect(decide(stranger.id).ok).toBe(false);
  expect(decide(boss.id)).toEqual({ ok: true });
});

test("agent proposal is always for its own agent layer", () => {
  const { db, org, dev } = managed();
  const p = propose(db, {
    orgId: org.id,
    memberId: dev.id,
    key: "router.failover",
    value: false,
    reason: "x",
    reviewers: [],
  });
  expect(p).toMatchObject({ layer: "agent", targetId: dev.id, proposedBy: dev.id, status: "open" });
  expect(() =>
    propose(db, {
      orgId: org.id,
      memberId: dev.id,
      key: "autonomy",
      value: "nope",
      reason: "x",
      reviewers: [],
    }),
  ).toThrow();
});

test("reviewer from another org → throws", () => {
  const { db, org, dev } = managed();
  const other = createOrg(db, {
    name: "B",
    slug: "bb",
    ownerUserId: "u2",
    ownerName: "O",
    ownerHandle: "o2",
  });
  const outsider = addAgentMember(db, other.id, {
    agentId: "claude",
    handle: "out",
    displayName: "out",
    specialties: [],
  });
  const input = {
    orgId: org.id,
    memberId: dev.id,
    key: "router.failover" as const,
    value: false,
    reason: "x",
  };
  expect(() => propose(db, { ...input, reviewers: [outsider.id] })).toThrow("reviewer not in org");
  const p = propose(db, { ...input, reviewers: [] });
  expect(() =>
    review(db, { proposalId: p.id, reviewerId: outsider.id, verdict: "approve", comment: "" }),
  ).toThrow();
  expect(() =>
    review(db, { proposalId: p.id, reviewerId: dev.id, verdict: "approve", comment: "" }),
  ).toThrow();
});

test("two concurrent decideProposal → one ok, other already decided", () => {
  const { db, org, dev } = managed();
  const seen: string[] = [];
  const off = onProposalChange((change) => seen.push(change.status));
  const p = propose(db, {
    orgId: org.id,
    memberId: dev.id,
    key: "router.failover",
    value: false,
    reason: "x",
    reviewers: [],
  });
  const decide = () =>
    decideProposal(db, {
      proposalId: p.id,
      decidedBy: { kind: "human", userId: "u1" },
      decision: "approve",
      reason: "",
    });
  const results = [decide(), decide()];
  off();
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: "already decided" });
  expect(seen).toEqual(["open", "approved"]);
});

test("PUT policies without step-up → 403 step_up_required", async () => {
  const k = bootApi();
  const owner = await k.user();
  const o = k.org(owner, "acme");
  const body = { layer: "org", targetId: o.id, key: "autonomy", value: "supervised" };
  const denied = await k.call(owner, "PUT", "/api/orgs/acme/policies", body);
  expect(denied.status).toBe(403);
  expect((await denied.json()).error).toBe("step_up_required");
  const admin = await k.user({ stepUp: true });
  k.join(o.id, admin, "admin", "adm");
  expect((await k.call(admin, "PUT", "/api/orgs/acme/policies", body)).status).toBe(200);
  const view = await (await k.call(admin, "GET", "/api/orgs/acme/policies")).json();
  expect(view.find((e: { key: string }) => e.key === "autonomy")).toMatchObject({
    value: "supervised",
    layer: "org",
  });
  const foreign = { ...body, targetId: "not-in-org" };
  expect((await k.call(admin, "PUT", "/api/orgs/acme/policies", foreign)).status).toBe(404);
  const loose = { ...body, layer: "org", value: "wild" };
  expect((await k.call(admin, "PUT", "/api/orgs/acme/policies", loose)).status).toBe(400);
});

test("harness layer needs an instance admin with step-up", async () => {
  const k = bootApi();
  const plain = await k.user({ stepUp: true });
  const admin = await k.user({ admin: true, stepUp: true });
  const body = { key: "router.failover", value: false };
  expect((await k.call(plain, "PUT", "/api/policies/harness", body)).status).toBe(403);
  expect((await k.call(admin, "PUT", "/api/policies/harness", body)).status).toBe(200);
  const stale = await k.user({ admin: true });
  expect((await (await k.call(stale, "PUT", "/api/policies/harness", body)).json()).error).toBe(
    "step_up_required",
  );
});
