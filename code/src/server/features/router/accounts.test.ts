import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { Engine } from "../../../shared/router";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { fakeAgents } from "../../test-support/agents-kit";
import { addAgentMember, createOrg } from "../orgs/api";
import { attachProfile, createProfile } from "../profiles/api";
import { recordQuota } from "../usage/api";
import { rankEngines, readyRuntimes, route } from "./api";

function setup(fallbacks: Engine[] = []): { db: Database; orgId: string; memberId: string } {
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
    fallbacks,
  });
  attachProfile(db, member.id, profile.id);
  return { db, orgId: org.id, memberId: member.id };
}

function addAccount(
  db: Database,
  id: string,
  runtime = "claude",
  over: { state?: string; maxConcurrent?: number; exhaustedUntil?: number | null } = {},
): void {
  db.run(
    `INSERT INTO agent_accounts
       (id, runtime, kind, label, home, state, max_concurrent, exhausted_until, created_at, updated_at)
     VALUES (?, ?, 'login', ?, '/h', ?, ?, ?, 1, 1)`,
    [id, runtime, id, over.state ?? "active", over.maxConcurrent ?? 2, over.exhaustedUntil ?? null],
  );
}

function seedRun(
  db: Database,
  over: { agentId?: string; accountId: string; state?: string; createdAt?: number },
): void {
  db.run(
    `INSERT INTO runs (id, agent_id, repo, prompt, state, created_at, account_id)
     VALUES (?, ?, '/r', 'p', ?, ?, ?)`,
    [
      Bun.randomUUIDv7(),
      over.agentId ?? "claude",
      over.state ?? "completed",
      over.createdAt ?? 1000,
      over.accountId,
    ],
  );
}

const quota = (
  db: Database,
  accountId: string,
  usedPercent: number,
  provider = "claude",
  resetsAt = Date.now() + 60_000,
): void => {
  recordQuota(db, {
    provider,
    accountId,
    window: "five_hour",
    usedPercent,
    resetsAt,
    source: "manual",
  });
};

const deps = fakeAgents("claude", "codex");

test("spread picks the account with more quota headroom", async () => {
  const { db, memberId } = setup();
  addAccount(db, "acct-a");
  addAccount(db, "acct-b");
  quota(db, "acct-a", 70);
  quota(db, "acct-b", 20);
  const [choice] = await route(db, { memberId }, deps);
  expect(choice?.engine).toEqual({ runtime: "claude", model: "opus", accountId: "acct-b" });
});

test("spread breaks headroom ties by least recently used account", async () => {
  const { db, memberId } = setup();
  addAccount(db, "acct-a");
  addAccount(db, "acct-b");
  quota(db, "acct-a", 40);
  quota(db, "acct-b", 40);
  seedRun(db, { accountId: "acct-a", state: "completed", createdAt: 5000 });
  const [choice] = await route(db, { memberId }, deps);
  expect(choice?.engine.accountId).toBe("acct-b");
});

test("when account A is exhausted by quota or exhausted_until, route picks account B", async () => {
  const { db, memberId } = setup();
  addAccount(db, "acct-a");
  addAccount(db, "acct-b");
  quota(db, "acct-a", 100);
  quota(db, "acct-b", 50);
  const [byQuota] = await route(db, { memberId }, deps);
  expect(byQuota?.engine.accountId).toBe("acct-b");

  const second = setup();
  addAccount(second.db, "acct-a", "claude", { exhaustedUntil: Date.now() + 60_000 });
  addAccount(second.db, "acct-b");
  const [byCooldown] = await route(second.db, { memberId: second.memberId }, deps);
  expect(byCooldown?.engine.accountId).toBe("acct-b");
});

test("when all accounts of the primary runtime are exhausted, route falls back to the next runtime", async () => {
  const { db, memberId } = setup([{ runtime: "codex", model: "gpt-5" }]);
  addAccount(db, "acct-a", "claude");
  addAccount(db, "acct-b", "claude", { exhaustedUntil: Date.now() + 60_000 });
  quota(db, "acct-a", 100);
  addAccount(db, "codex-a", "codex");
  const choices = await route(db, { memberId }, deps);
  expect(choices.map((c) => c.engine)).toEqual([
    { runtime: "codex", model: "gpt-5", accountId: "codex-a" },
  ]);
});

test("exclude with accountId drops only that account and keeps the runtime", async () => {
  const { db, memberId } = setup();
  addAccount(db, "acct-a");
  addAccount(db, "acct-b");
  quota(db, "acct-a", 10);
  quota(db, "acct-b", 60);
  const [choice] = await route(
    db,
    { memberId, exclude: [{ runtime: "claude", model: "opus", accountId: "acct-a" }] },
    deps,
  );
  expect(choice?.engine).toEqual({ runtime: "claude", model: "opus", accountId: "acct-b" });
});

test("an account at max_concurrent live runs is skipped", async () => {
  const { db, memberId } = setup();
  addAccount(db, "acct-a", "claude", { maxConcurrent: 1 });
  addAccount(db, "acct-b", "claude", { maxConcurrent: 2 });
  quota(db, "acct-a", 10);
  quota(db, "acct-b", 60);
  seedRun(db, { accountId: "acct-a", state: "running" });
  const [choice] = await route(db, { memberId }, deps);
  expect(choice?.engine.accountId).toBe("acct-b");
});

test("non-usable account states are skipped; active and unknown are eligible", async () => {
  const { db, memberId } = setup();
  for (const state of [
    "disabled",
    "logged_out",
    "pending",
    "removed",
    "removing",
    "probe_failed",
  ]) {
    addAccount(db, `skip-${state}`, "claude", { state });
  }
  addAccount(db, "ok-unknown", "claude", { state: "unknown" });
  const first = await route(db, { memberId }, deps);
  expect(first[0]?.engine.accountId).toBe("ok-unknown");

  addAccount(db, "ok-active", "claude", { state: "active" });
  quota(db, "ok-unknown", 80);
  quota(db, "ok-active", 20);
  const second = await route(db, { memberId }, deps);
  expect(second[0]?.engine.accountId).toBe("ok-active");
});

test("readyRuntimes and rankEngines stay ready if any account is eligible and score with best headroom", async () => {
  const { db, orgId } = setup();
  addAccount(db, "default:claude", "claude");
  addAccount(db, "acct-b", "claude");
  addAccount(db, "codex-a", "codex");
  quota(db, "default:claude", 100);
  quota(db, "acct-b", 10);
  quota(db, "codex-a", 80, "codex");

  const ready = await readyRuntimes(db, deps);
  expect(ready.has("claude")).toBe(true);
  expect(ready.has("codex")).toBe(true);

  const ranked = await rankEngines(db, { orgId, difficulty: "medium", taskType: "feature" }, deps);
  expect(ranked[0]).toEqual({ runtime: "claude", model: null, accountId: "acct-b" });
  expect(ranked[1]).toEqual({ runtime: "codex", model: null, accountId: "codex-a" });
});
