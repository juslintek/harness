import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { bootApi } from "../../test-support/api-kit";
import { createTask } from "../board/api";
import { addAgentMember, createOrg, createProject, listTeams } from "../orgs/api";
import { decideProposal, getProposal, propose, review, setPolicy } from "./api";

const policyRows = (db: Database): number =>
  db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM policies").get()?.n ?? 0;

test("an admin of org A cannot read, write or clear org B's team, member, task or org rows", async () => {
  const k = bootApi();
  const admin = await k.user({ stepUp: true });
  const a = k.org(admin, "alpha");
  const b = k.org(await k.user(), "beta");
  const team = listTeams(k.db, b.id)[0]?.id as string;
  const member = addAgentMember(k.db, b.id, {
    agentId: "claude",
    handle: "dev",
    displayName: "dev",
    specialties: [],
  });
  const project = createProject(k.db, { orgId: b.id, key: "P", name: "P" });
  const task = createTask(k.db, { projectId: project.id, title: "t", createdBy: b.owner.id });
  expect(a.id).not.toBe(b.id);

  const foreign = [
    { layer: "org", targetId: b.id },
    { layer: "team", targetId: team },
    { layer: "agent", targetId: member.id },
    { layer: "task", targetId: task.id },
  ];
  for (const target of foreign) {
    const body = { ...target, key: "router.failover", value: false };
    expect((await k.call(admin, "PUT", "/api/orgs/alpha/policies", body)).status).toBe(404);
  }
  expect(policyRows(k.db)).toBe(0);

  for (const target of foreign) {
    setPolicy(k.db, { ...target, key: "router.failover", value: false, setBy: "x" } as Parameters<
      typeof setPolicy
    >[1]);
  }
  expect(policyRows(k.db)).toBe(4);
  for (const target of foreign) {
    const qs = `layer=${target.layer}&targetId=${target.targetId}&key=router.failover`;
    expect((await k.call(admin, "DELETE", `/api/orgs/alpha/policies?${qs}`)).status).toBe(404);
  }
  expect(policyRows(k.db)).toBe(4);

  for (const qs of [`team=${team}`, `member=${member.id}`, `task=${task.id}`]) {
    expect((await k.call(admin, "GET", `/api/orgs/alpha/policies?${qs}`)).status).toBe(404);
  }
});

// Stands in for a second decider that wins the race between the pre-check read and the claim.
function racingDb(db: Database, onStaleRead: () => void): Database {
  let fired = false;
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "query") return typeof value === "function" ? value.bind(target) : value;
      return (sql: string) => {
        const statement = target.query(sql);
        if (fired || !sql.startsWith("SELECT * FROM policy_proposals WHERE id")) return statement;
        return {
          get: (...args: never[]) => {
            const row = statement.get(...args);
            fired = true;
            onStaleRead();
            return row;
          },
        };
      };
    },
  });
}

test("the atomic claim refuses a decide whose pre-check saw the proposal still open", () => {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const org = createOrg(db, {
    name: "A",
    slug: "aa",
    ownerUserId: "u1",
    ownerName: "O",
    ownerHandle: "owner",
  });
  const dev = addAgentMember(db, org.id, {
    agentId: "claude",
    handle: "dev",
    displayName: "dev",
    specialties: [],
  });
  const p = propose(db, {
    orgId: org.id,
    memberId: dev.id,
    key: "router.failover",
    value: false,
    reason: "x",
    reviewers: [],
  });
  const decide = (target: Database, decision: "approve" | "reject") =>
    decideProposal(target, {
      proposalId: p.id,
      decidedBy: { kind: "human", userId: "u1" },
      decision,
      reason: "",
    });
  const loser = racingDb(db, () => expect(decide(db, "approve")).toEqual({ ok: true }));
  expect(decide(loser, "reject")).toEqual({ ok: false, reason: "already decided" });
  expect(policyRows(db)).toBe(1);
  expect(db.query("SELECT status FROM policy_proposals WHERE id = ?").get(p.id)).toEqual({
    status: "approved",
  });
});

test("review refuses a same-org member who was not invited and stores nothing", () => {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const org = createOrg(db, {
    name: "A",
    slug: "aa",
    ownerUserId: "u1",
    ownerName: "O",
    ownerHandle: "owner",
  });
  const agent = (handle: string) =>
    addAgentMember(db, org.id, { agentId: "claude", handle, displayName: handle, specialties: [] });
  const [dev, invited, stranger] = [agent("dev"), agent("invited"), agent("stranger")];
  const proposal = propose(db, {
    orgId: org.id,
    memberId: dev.id,
    key: "router.failover",
    value: false,
    reason: "x",
    reviewers: [invited.id],
  });
  expect(() =>
    review(db, {
      proposalId: proposal.id,
      reviewerId: stranger.id,
      verdict: "reject",
      comment: "",
    }),
  ).toThrow("not invited to review this proposal");
  expect(getProposal(db, proposal.id)?.reviews).toEqual([]);
  review(db, {
    proposalId: proposal.id,
    reviewerId: invited.id,
    verdict: "approve",
    comment: "ok",
  });
  expect(getProposal(db, proposal.id)?.reviews).toEqual([
    { reviewerId: invited.id, verdict: "approve", comment: "ok" },
  ]);
});
