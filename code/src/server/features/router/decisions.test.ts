import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { fakeAgents } from "../../test-support/agents-kit";
import { bootApi } from "../../test-support/api-kit";
import { addAgentMember, createOrg } from "../orgs/api";
import { setPolicy } from "../policies/api";
import { attachProfile, createProfile } from "../profiles/api";
import { recordQuota } from "../usage/api";
import { linkRouteDecision, listRouteDecisions, pruneRouteDecisions, routeOutcome } from "./api";

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
  const member = addAgentMember(db, org.id, {
    agentId: "claude",
    model: "opus",
    handle: "dev",
    displayName: "dev",
    specialties: [],
  });
  const profile = createProfile(db, org.id, {
    runtime: "claude",
    model: "opus",
    persona: "",
    skills: [],
    scope: { readOnly: false },
    fallbacks: [],
  });
  attachProfile(db, member.id, profile.id);
  return { db, orgId: org.id, memberId: member.id };
}

function addAccount(
  db: Database,
  id: string,
  over: { state?: string; priority?: number; exhaustedUntil?: number | null } = {},
): void {
  db.run(
    `INSERT INTO agent_accounts
       (id, runtime, kind, label, home, state, max_concurrent, priority, exhausted_until, created_at, updated_at)
     VALUES (?, 'claude', 'login', ?, '/h', ?, 2, ?, ?, 1, 1)`,
    [id, id, over.state ?? "active", over.priority ?? 0, over.exhaustedUntil ?? null],
  );
}

const deps = fakeAgents("claude");

test("a pick writes one route_decisions row with scores, first rejecting filter, policy, and chosen account", async () => {
  const { db, orgId, memberId } = setup();
  setPolicy(db, {
    layer: "org",
    targetId: orgId,
    key: "router.accountPolicy",
    value: "drain",
    setBy: "u1",
  });
  addAccount(db, "acct-good", { priority: 1 });
  addAccount(db, "acct-disabled", { state: "disabled", priority: 0 });
  addAccount(db, "acct-full", { priority: 0 });
  recordQuota(db, {
    provider: "claude",
    accountId: "acct-full",
    window: "five_hour",
    usedPercent: 100,
    resetsAt: Date.now() + 60_000,
    source: "manual",
  });

  const out = await routeOutcome(db, { memberId }, deps);
  expect(out.choices[0]?.engine.accountId).toBe("acct-good");
  expect(out.decisionId).toBeTruthy();
  linkRouteDecision(db, out.decisionId as string, "run-123");

  const rows = listRouteDecisions(db, { limit: 10 });
  expect(rows).toHaveLength(1);
  const [d] = rows;
  expect(d?.runId).toBe("run-123");
  expect(d?.policy).toBe("drain");
  expect(d?.chosenAccount).toBe("acct-good");
  expect(d?.totalCandidates).toBe(3);
  const byAcct = new Map(d?.candidates.map((c) => [c.account, c]));
  expect(byAcct.get("acct-good")).toMatchObject({ rejectedBy: null });
  expect(typeof byAcct.get("acct-good")?.score).toBe("number");
  expect(byAcct.get("acct-disabled")?.rejectedBy).toBe("state");
  expect(byAcct.get("acct-full")?.rejectedBy).toBe("quota_full");
});

test("caps candidates at 10 and keeps candidates_json under 8 KB with 200 candidates", async () => {
  const { db, memberId } = setup();
  for (let i = 0; i < 200; i++) {
    addAccount(db, `acct-${String(i).padStart(3, "0")}-${"x".repeat(40)}`);
  }
  await routeOutcome(db, { memberId }, deps);
  const raw = db
    .query<{ candidates_json: string }, []>("SELECT candidates_json FROM route_decisions")
    .get();
  expect(raw).not.toBeNull();
  expect(Buffer.byteLength(raw?.candidates_json ?? "", "utf8")).toBeLessThanOrEqual(8192);
  const [d] = listRouteDecisions(db, { limit: 10 });
  expect(d?.totalCandidates).toBe(200);
  expect(d?.candidates.length).toBeLessThanOrEqual(10);
});

test("rows older than 30 days are pruned while recent rows stay", async () => {
  const { db, memberId } = setup();
  addAccount(db, "acct-a");
  await routeOutcome(db, { memberId }, deps);
  await routeOutcome(db, { memberId }, deps);
  const all = listRouteDecisions(db, { limit: 10 });
  const oldId = all[1]?.id as string;
  const now = Date.now();
  db.run("UPDATE route_decisions SET ts = ? WHERE id = ?", [now - 31 * 24 * 60 * 60_000, oldId]);
  expect(pruneRouteDecisions(db, now)).toBe(1);
  expect(listRouteDecisions(db, { limit: 10 })).toHaveLength(1);
});

test("GET /api/router/decisions requires instance admin and returns decisions", async () => {
  const kit = bootApi();
  const admin = await kit.user({ admin: true });
  const plain = await kit.user({ admin: false });
  expect((await kit.call(plain, "GET", "/api/router/decisions")).status).toBe(403);
  const org = createOrg(kit.db, {
    name: "A",
    slug: "aa",
    ownerUserId: "u1",
    ownerName: "O",
    ownerHandle: "owner",
  });
  const member = addAgentMember(kit.db, org.id, {
    agentId: "claude",
    model: "opus",
    handle: "dev",
    displayName: "dev",
    specialties: [],
  });
  addAccount(kit.db, "acct-a");
  await routeOutcome(kit.db, { memberId: member.id }, deps);

  const res = await kit.call(admin, "GET", "/api/router/decisions?limit=5");
  expect(res.status).toBe(200);
  const body = (await res.json()) as Array<{ chosenAccount: string | null }>;
  expect(body).toHaveLength(1);
  expect(body[0]?.chosenAccount).toBe("acct-a");
});
