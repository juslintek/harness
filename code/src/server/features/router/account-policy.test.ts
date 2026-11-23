import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { fakeAgents } from "../../test-support/agents-kit";
import { createTask } from "../board/api";
import { addAgentMember, addToTeam, createOrg, createProject, listTeams } from "../orgs/api";
import { setPolicy } from "../policies/api";
import { attachProfile, createProfile } from "../profiles/api";
import { recordQuota } from "../usage/api";
import { rankEngines, route } from "./api";

function setup() {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const org = createOrg(db, {
    name: "A",
    slug: "aa",
    ownerUserId: "u1",
    ownerName: "O",
    ownerHandle: "owner",
  });
  const teamId = listTeams(db, org.id)[0]?.id as string;
  const project = createProject(db, { orgId: org.id, name: "P", key: "P" });
  const member = addAgentMember(db, org.id, {
    agentId: "claude",
    model: "opus",
    handle: "dev",
    displayName: "dev",
    specialties: [],
  });
  addToTeam(db, teamId, member.id);
  const profile = createProfile(db, org.id, {
    runtime: "claude",
    model: "opus",
    persona: "",
    skills: [],
    scope: { readOnly: false },
    fallbacks: [],
  });
  attachProfile(db, member.id, profile.id);
  const task = createTask(db, {
    projectId: project.id,
    title: "work",
    createdBy: member.id,
  });
  return { db, orgId: org.id, teamId, memberId: member.id, taskId: task.id };
}

function addAccount(
  db: Database,
  id: string,
  over: { priority?: number; createdAt?: number; exhaustedUntil?: number | null } = {},
): void {
  db.run(
    `INSERT INTO agent_accounts
       (id, runtime, kind, label, home, state, max_concurrent, priority, exhausted_until, created_at, updated_at)
     VALUES (?, 'claude', 'login', ?, '/h', 'active', 2, ?, ?, ?, 1)`,
    [id, id, over.priority ?? 0, over.exhaustedUntil ?? null, over.createdAt ?? 1],
  );
}

function quota(
  db: Database,
  accountId: string,
  usedPercent: number,
  resetsAt: number | null,
  window = "five_hour",
): void {
  recordQuota(db, {
    provider: "claude",
    accountId,
    window,
    usedPercent,
    resetsAt,
    source: "manual",
  });
}

const deps = fakeAgents("claude");

test("drain picks lowest priority first and moves on only when exhausted", async () => {
  const { db, orgId, memberId } = setup();
  setPolicy(db, {
    layer: "org",
    targetId: orgId,
    key: "router.accountPolicy",
    value: "drain",
    setBy: "u1",
  });
  addAccount(db, "acct-low", { priority: 1 });
  addAccount(db, "acct-high", { priority: 5 });
  // acct-low has far less headroom than acct-high, yet drain still sticks to acct-low.
  quota(db, "acct-low", 85, Date.now() + 3600_000);
  quota(db, "acct-high", 10, Date.now() + 3600_000);

  const [first] = await route(db, { memberId }, deps);
  expect(first?.engine.accountId).toBe("acct-low");

  // Once acct-low hits 100%, drain moves to acct-high.
  quota(db, "acct-low", 100, Date.now() + 3600_000);
  const [second] = await route(db, { memberId }, deps);
  expect(second?.engine.accountId).toBe("acct-high");
});

test("drain keeps draining the same account on equal priority instead of alternating by LRU", async () => {
  const { db, orgId, memberId } = setup();
  setPolicy(db, {
    layer: "org",
    targetId: orgId,
    key: "router.accountPolicy",
    value: "drain",
    setBy: "u1",
  });
  addAccount(db, "acct-a", { priority: 0, createdAt: 10 });
  addAccount(db, "acct-b", { priority: 0, createdAt: 20 });
  db.run(
    "INSERT INTO runs (id, agent_id, repo, prompt, state, created_at, account_id) VALUES ('r1', 'claude', '/r', 'p', 'completed', 9999, 'acct-a')",
  );
  const [choice] = await route(db, { memberId }, deps);
  expect(choice?.engine.accountId).toBe("acct-a");
});

test("expiring picks the account whose window resets soonest among accounts with headroom", async () => {
  const { db, orgId, memberId } = setup();
  setPolicy(db, {
    layer: "org",
    targetId: orgId,
    key: "router.accountPolicy",
    value: "expiring",
    setBy: "u1",
  });
  const now = Date.now();
  addAccount(db, "acct-exhausted");
  addAccount(db, "acct-soon");
  addAccount(db, "acct-later");
  addAccount(db, "acct-unknown");
  quota(db, "acct-exhausted", 100, now + 10_000);
  quota(db, "acct-soon", 75, now + 60_000);
  quota(db, "acct-later", 10, now + 600_000);

  const [choice] = await route(db, { memberId }, deps);
  expect(choice?.engine.accountId).toBe("acct-soon");
});

test("router.accountPolicy resolves through org, team, agent, and task layers", async () => {
  const { db, orgId, teamId, memberId, taskId } = setup();
  const now = Date.now();
  addAccount(db, "acct-priority", { priority: 1 });
  addAccount(db, "acct-expiring", { priority: 2 });
  addAccount(db, "acct-headroom", { priority: 3 });
  quota(db, "acct-priority", 80, now + 600_000);
  quota(db, "acct-expiring", 60, now + 60_000);
  quota(db, "acct-headroom", 10, now + 900_000);
  const put = (layer: "org" | "team" | "agent" | "task", targetId: string, value: string) =>
    setPolicy(db, { layer, targetId, key: "router.accountPolicy", value, setBy: "u1" });
  const pick = async () => (await route(db, { memberId, taskId }, deps))[0]?.engine.accountId;

  expect(await pick()).toBe("acct-headroom");
  put("org", orgId, "drain");
  expect(await pick()).toBe("acct-priority");
  put("team", teamId, "expiring");
  expect(await pick()).toBe("acct-expiring");
  put("agent", memberId, "spread");
  expect(await pick()).toBe("acct-headroom");
  put("task", taskId, "drain");
  expect(await pick()).toBe("acct-priority");

  const ranked = await rankEngines(db, { orgId, difficulty: "medium", taskType: null }, deps);
  expect(ranked[0]?.accountId).toBe("acct-priority");
});

test("router.accountPolicy rejects invalid values", () => {
  const { db, orgId } = setup();
  expect(
    setPolicy(db, {
      layer: "org",
      targetId: orgId,
      key: "router.accountPolicy",
      value: "round_robin",
      setBy: "u1",
    }),
  ).toEqual({ ok: false, reason: "invalid value" });
  expect(
    setPolicy(db, {
      layer: "org",
      targetId: orgId,
      key: "router.accountPolicy",
      value: "expiring",
      setBy: "u1",
    }),
  ).toEqual({ ok: true });
});
