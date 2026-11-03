import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import type { AgentView } from "../agents/api";
import { addAgentMember, createOrg } from "../orgs/api";
import { setPolicy } from "../policies/api";
import { attachProfile, createProfile } from "../profiles/api";
import { recordQuota } from "../usage/api";
import { route } from "./candidates";
import { type ScoreInput, scoreEngine } from "./score";

const price = (input: number, output: number): ScoreInput["price"] => ({
  input,
  output,
  cacheRead: input,
});
const engine = { runtime: "claude", model: "m" };
const base: ScoreInput = {
  engine,
  primary: false,
  triage: null,
  price: null,
  headroom: null,
  stat: null,
};

test("scoreEngine: a hard task prefers tier 3 over tier 1", () => {
  const triage = { difficulty: "hard" as const };
  const big = scoreEngine({ ...base, triage, price: price(15, 75) });
  const small = scoreEngine({ ...base, triage, price: price(1, 5) });
  expect(big).toBeGreaterThan(small);
});

test("scoreEngine: an easy task prefers the cheaper of two tier-fitting engines", () => {
  const triage = { difficulty: "easy" as const };
  const cheap = scoreEngine({ ...base, triage, price: price(1, 5) });
  const dear = scoreEngine({ ...base, triage, price: price(15, 75) });
  expect(cheap).toBeGreaterThan(dear);
});

test("scoreEngine: no data gives 0.5 for headroom, cost and learned, tier 2 for fit", () => {
  // fit 1 against a medium need, the other three parts 0.5.
  expect(scoreEngine(base)).toBeCloseTo(0.35 + 0.25 * 0.5 + 0.15 * 0.5 + 0.2 * 0.5, 10);
  expect(scoreEngine({ ...base, primary: true })).toBeCloseTo(0.65 + 0.05, 10);
});

test("scoreEngine: learned success rate is smoothed", () => {
  const stat = {
    runtime: "claude",
    model: "m",
    taskType: null,
    runs: 8,
    completed: 8,
    medianMinutes: null,
    avgTokens: null,
  };
  expect(scoreEngine({ ...base, stat }) - scoreEngine(base)).toBeCloseTo(0.2 * (0.9 - 0.5), 10);
});

function agent(id: string, over: Partial<AgentView> = {}): AgentView {
  return {
    id,
    name: id,
    lane: "acp",
    installed: true,
    path: null,
    version: null,
    loggedIn: true,
    error: null,
    canLogin: true,
    enabled: true,
    models: [],
    ...over,
  };
}

function world(
  fallbacks: Array<{ runtime: string; model: string | null }> = [],
  runtime = "claude",
): { db: Database; orgId: string; memberId: string } {
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
    agentId: runtime,
    model: "opus",
    handle: "dev",
    displayName: "dev",
    specialties: [],
  });
  const profile = createProfile(db, org.id, {
    runtime,
    model: "opus",
    persona: "",
    skills: [],
    scope: { readOnly: false },
    fallbacks,
  });
  attachProfile(db, member.id, profile.id);
  return { db, orgId: org.id, memberId: member.id };
}

const all = [agent("claude"), agent("codex"), agent("agy")];
const deps = { agents: () => Promise.resolve(all) };
const runtimes = async (db: Database, memberId: string, exclude = []): Promise<string[]> =>
  (await route(db, { memberId, exclude }, deps)).map((c) => c.engine.runtime);

test("route excludes a runtime whose quota is 100% until resetsAt", async () => {
  const { db, memberId } = world();
  const reset = Date.now() + 60_000;
  recordQuota(db, {
    provider: "claude",
    window: "five_hour",
    usedPercent: 100,
    resetsAt: reset,
    source: "manual",
  });
  expect(await runtimes(db, memberId)).toEqual(["codex", "agy"]);
  recordQuota(db, {
    provider: "claude",
    window: "five_hour",
    usedPercent: 100,
    resetsAt: Date.now() - 1,
    source: "manual",
  });
  expect(await runtimes(db, memberId)).toContain("claude");
});

test("route respects router.allowedRuntimes from policies", async () => {
  const { db, orgId, memberId } = world();
  const set = setPolicy(db, {
    layer: "org",
    targetId: orgId,
    key: "router.allowedRuntimes",
    value: ["codex"],
    setBy: "test",
  });
  expect(set).toEqual({ ok: true });
  expect(await runtimes(db, memberId)).toEqual(["codex"]);
});

test("route drops runtimes that are not linked or are logged out", async () => {
  const { db, memberId } = world();
  const few = {
    agents: () =>
      Promise.resolve([
        agent("claude"),
        agent("codex", { enabled: false }),
        agent("agy", { loggedIn: false }),
      ]),
  };
  const got = await route(db, { memberId }, few);
  expect(got.map((c) => c.engine.runtime)).toEqual(["claude"]);
});

test("route puts the profile primary first when scores tie", async () => {
  const { db, memberId } = world();
  const got = await route(db, { memberId }, deps);
  expect(got[0]?.engine).toEqual({ runtime: "claude", model: "opus" });
  expect(got[0]?.reasons).toContain("profile primary");
});

test("route uses the profile fallbacks when it has some, and honours exclude", async () => {
  const fallbacks = [{ runtime: "codex", model: "gpt-5" }];
  const { db, memberId } = world(fallbacks);
  expect((await route(db, { memberId }, deps)).map((c) => c.engine.runtime)).toEqual([
    "claude",
    "codex",
  ]);
  const left = await route(db, { memberId, exclude: [fallbacks[0] as never] }, deps);
  expect(left.map((c) => c.engine.runtime)).toEqual(["claude"]);
});
