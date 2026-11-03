import type { Database } from "bun:sqlite";
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { bootApi } from "../../test-support/api-kit";
import { wireChat } from "../chat/api";
import { addAgentMember, addToTeam, createOrg, createTeam } from "../orgs/api";
import { refreshRegistry } from "../router/api";
import { recordUsage } from "../usage/api";
import { budgetGate } from "./api";
import { upsertBudget } from "./repo";
import { periodStartOf, spendUsd } from "./spend";
import { startBudgets } from "./watch";

afterEach(() => setSystemTime());

function world(db: Database) {
  wireChat(db);
  const org = createOrg(db, {
    name: "Acme",
    slug: "acme",
    ownerUserId: "u1",
    ownerName: "Owner",
    ownerHandle: "owner",
  });
  const agent = (handle: string, agentId = "fake") =>
    addAgentMember(db, org.id, { agentId, handle, displayName: handle, specialties: [] });
  return { org, agent };
}

function runOf(db: Database, memberId: string, agentId = "fake"): string {
  const id = Bun.randomUUIDv7();
  db.run(
    "INSERT INTO runs (id, agent_id, repo, prompt, state, created_at, member_id) VALUES (?, ?, '/r', 'p', 'running', ?, ?)",
    [id, agentId, Date.now(), memberId],
  );
  return id;
}

const spend = (db: Database, runId: string, agent: string, usd: number | null, model = "m") =>
  recordUsage(db, { id: runId, agent }, [
    {
      model,
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      reportedCostUsd: usd,
      source: "acp",
    },
  ]);

const budget = (
  db: Database,
  orgId: string,
  kind: "org" | "team" | "member",
  id: string,
  usd: number,
) => upsertBudget(db, orgId, { scopeKind: kind, scopeId: id, monthlyUsd: usd }, "owner");

const posts = (db: Database): string[] =>
  db
    .query<{ body: string; author_id: string | null }, []>("SELECT body, author_id FROM messages")
    .all()
    .map((m) => m.body);

function mem(): Database {
  const db = openDb(":memory:");
  migrate(db, migrations);
  return db;
}

test("spend counts reported cost and registry-estimated cost for NULL cost (codex)", async () => {
  const db = mem();
  await refreshRegistry(db, () =>
    Bun.file(new URL("../router/fixtures/models-dev.json", import.meta.url)).json(),
  );
  const { org, agent } = world(db);
  const claude = agent("c1", "claude");
  const codex = agent("x1", "codex");
  spend(db, runOf(db, claude.id, "claude"), "claude", 2.5);
  spend(db, runOf(db, codex.id, "codex"), "codex", null, "gpt-5");
  spend(db, runOf(db, codex.id, "codex"), "codex", null, "no-such-model");
  const scope = { kind: "org", id: org.id } as const;
  expect(spendUsd(db, scope, periodStartOf(Date.now()))).toBeCloseTo(3.75);
  const b = budget(db, org.id, "org", org.id, 10);
  expect(budgetGate(db, codex.id).budgets[0]).toMatchObject({ id: b.id, unpriced: 1 });
});

test("crossing 80% posts one warn message, a second usage at 85% posts nothing", () => {
  const db = mem();
  const { org, agent } = world(db);
  const bob = agent("bob");
  budget(db, org.id, "org", org.id, 10);
  const stop = startBudgets(db);
  const run = runOf(db, bob.id);
  spend(db, run, "fake", 7);
  expect(posts(db)).toEqual([]);
  spend(db, run, "fake", 1);
  expect(posts(db)).toEqual(["Budget org Acme at 80% of 10 USD"]);
  spend(db, run, "fake", 0.5);
  stop();
  expect(posts(db)).toHaveLength(1);
  expect(budgetGate(db, bob.id).state).toBe("warn");
  expect(db.query("SELECT 1 FROM budget_alerts WHERE level = 'warn'").all()).toHaveLength(1);
});

test("raising the limit makes budgetGate ok again", () => {
  const db = mem();
  const { org, agent } = world(db);
  const bob = agent("bob");
  budget(db, org.id, "org", org.id, 10);
  spend(db, runOf(db, bob.id), "fake", 12);
  expect(budgetGate(db, bob.id).state).toBe("paused");
  budget(db, org.id, "org", org.id, 100);
  expect(budgetGate(db, bob.id).state).toBe("ok");
});

test("team budget covers only members of that team", () => {
  const db = mem();
  const { org, agent } = world(db);
  const [inTeam, outside] = [agent("in"), agent("out")] as const;
  const team = createTeam(db, org.id, "Blue");
  addToTeam(db, team.id, inTeam.id);
  budget(db, org.id, "team", team.id, 5);
  spend(db, runOf(db, inTeam.id), "fake", 6);
  spend(db, runOf(db, outside.id), "fake", 3);
  expect(budgetGate(db, inTeam.id).state).toBe("paused");
  expect(budgetGate(db, outside.id)).toEqual({ state: "ok", budgets: [] });
});

test("new month resets the period", () => {
  const db = mem();
  const { org, agent } = world(db);
  const bob = agent("bob");
  budget(db, org.id, "org", org.id, 10);
  const stop = startBudgets(db);
  const run = runOf(db, bob.id);
  setSystemTime(new Date("2031-01-20T10:00:00Z"));
  spend(db, run, "fake", 9);
  expect(posts(db)).toHaveLength(1);
  setSystemTime(new Date("2031-02-02T10:00:00Z"));
  expect(budgetGate(db, bob.id).state).toBe("ok");
  spend(db, run, "fake", 9);
  stop();
  expect(posts(db)).toHaveLength(2);
});

test("PUT with monthlyUsd 0 is a 400, a valid PUT then DELETE works and a foreign scope is refused", async () => {
  const k = bootApi();
  const owner = await k.user({ stepUp: true });
  const acme = k.org(owner, "acme");
  const put = (body: unknown) => k.call(owner, "PUT", "/api/orgs/acme/budgets", body);
  const scope = { scopeKind: "org", scopeId: acme.id };
  expect((await put({ ...scope, monthlyUsd: 0 })).status).toBe(400);
  expect((await put({ scopeKind: "org", scopeId: "other-org", monthlyUsd: 5 })).status).toBe(400);
  const rival = await k.user({ stepUp: true });
  const beta = k.org(rival, "beta");
  const betaTeam = createTeam(k.db, beta.id, "Red");
  const betaAgent = addAgentMember(k.db, beta.id, {
    agentId: "fake",
    handle: "eve",
    displayName: "eve",
    specialties: [],
  });
  for (const [scopeKind, scopeId] of [
    ["org", beta.id],
    ["team", betaTeam.id],
    ["member", betaAgent.id],
  ] as const) {
    expect((await put({ scopeKind, scopeId, monthlyUsd: 5 })).status).toBe(400);
  }
  expect(k.db.query("SELECT 1 FROM budgets").all()).toHaveLength(0);
  const saved = await (await put({ ...scope, monthlyUsd: 5 })).json();
  expect(saved).toMatchObject({ monthlyUsd: 5, state: "ok" });
  const list = await (await k.call(owner, "GET", "/api/orgs/acme/budgets")).json();
  expect(list).toHaveLength(1);
  expect((await k.call(owner, "DELETE", `/api/orgs/acme/budgets/${saved.id}`)).status).toBe(200);
  expect((await k.call(owner, "DELETE", `/api/orgs/acme/budgets/${saved.id}`)).status).toBe(404);
});
