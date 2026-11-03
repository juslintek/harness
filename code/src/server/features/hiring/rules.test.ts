import { expect, test } from "bun:test";
import { hiringWorld } from "../../test-support/hiring-kit";
import { addAgentMember, addHumanMember, createOrg } from "../orgs/api";
import { setPolicy } from "../policies/api";
import { submitCard } from "../profiles/api";
import { advance, decide, getHire, pass, score } from "./api";

function atDeciding() {
  const w = hiringWorld();
  const rev = w.agent("rev1");
  setPolicy(w.db, {
    layer: "org",
    targetId: w.orgId,
    key: "hiring.decision",
    value: "human",
    setBy: "u1",
  });
  const hire = w.file(rev.id);
  w.answerAll(hire);
  for (const r of getHire(w.db, hire.id)?.reviewers ?? []) pass(w.db, w.deps, hire.id, r.memberId);
  for (const c of hire.candidates) {
    for (const r of [rev.id, w.boss.id]) {
      score(w.db, w.deps, {
        candidateId: c.id,
        scorerId: r,
        fit: 3,
        depth: 3,
        honesty: 3,
        notes: "",
      });
    }
  }
  return { w, rev, hire, pick: hire.candidates[0]?.id as string };
}

test("only an admin of the request's org, or the woken manager, may decide", () => {
  const { w, rev, hire, pick } = atDeciding();
  const ask = (decidedBy: string) =>
    decide(w.db, w.deps, { requestId: hire.id, candidateId: pick, decidedBy, reason: "" });
  const refused = { ok: false, reason: "not allowed to decide" };

  const other = createOrg(w.db, {
    name: "B",
    slug: "bb",
    ownerUserId: "u2",
    ownerName: "P",
    ownerHandle: "pat",
  });
  const foreignAdmin = addHumanMember(w.db, other.id, "u3", "adm", "adm", "admin");
  const foreignAgent = addAgentMember(w.db, other.id, {
    agentId: "claude",
    handle: "lead",
    displayName: "l",
    specialties: [],
  });
  const viewer = addHumanMember(w.db, w.orgId, "u4", "view", "view", "viewer");
  for (const id of [foreignAdmin.id, foreignAgent.id, viewer.id, rev.id, "someone"]) {
    expect(ask(id)).toEqual(refused);
  }
  expect(getHire(w.db, hire.id)?.status).toBe("deciding");

  expect(ask(w.boss.id).ok).toBe(true);
});

test("a human admin of the org may decide", () => {
  const { w, hire, pick } = atDeciding();
  const result = decide(w.db, w.deps, {
    requestId: hire.id,
    candidateId: pick,
    decidedBy: w.ownerId,
    reason: "",
  });
  expect(result.ok).toBe(true);
});

test("after a scoring timeout an unreviewed candidate cannot beat a reviewed one", () => {
  const w = hiringWorld();
  const rev = w.agent("rev1");
  setPolicy(w.db, {
    layer: "org",
    targetId: w.orgId,
    key: "hiring.decision",
    value: "auto",
    setBy: "u1",
  });
  const hire = w.file(rev.id);
  const [reviewed, unreviewed] = hire.candidates;
  // The reviewed one has the weaker system score (no specialty match) on purpose.
  submitCard(w.db, reviewed?.profile.id as string, {
    summary: "Frontend dev",
    specialties: ["frontend"],
    strengths: [],
    limits: ["no backend"],
    preferredTaskTypes: ["feature"],
  });
  w.answerAll(hire, [1]);
  for (const r of getHire(w.db, hire.id)?.reviewers ?? []) pass(w.db, w.deps, hire.id, r.memberId);
  score(w.db, w.deps, {
    candidateId: reviewed?.id as string,
    scorerId: w.boss.id,
    fit: 3,
    depth: 3,
    honesty: 3,
    notes: "",
  });
  w.clock.now += 21 * 60 * 1000;
  advance(w.db, w.deps, hire.id);
  const done = getHire(w.db, hire.id);
  expect(done?.candidates[0]?.total).toBeCloseTo(3.2);
  expect(done?.candidates[1]?.systemScore).toBeCloseTo(5);
  expect(done?.candidates[1]?.total).toBeCloseTo(2);
  expect(unreviewed?.id).toBe(done?.candidates[1]?.id as string);
  expect(done?.status).toBe("rejected");
  expect(done?.hiredMemberId).toBeNull();
});
