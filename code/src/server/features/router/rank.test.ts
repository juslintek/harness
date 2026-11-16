import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createOrg } from "../orgs/api";
import { setPolicy } from "../policies/api";
import { recordQuota } from "../usage/api";
import { rankEngines, readyRuntimes } from "./api";
import { agents } from "./failover-kit";

function fresh(): { db: ReturnType<typeof openDb>; orgId: string } {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const org = createOrg(db, {
    name: "A",
    slug: "aa",
    ownerUserId: "u1",
    ownerName: "O",
    ownerHandle: "owner",
  });
  return { db, orgId: org.id };
}

const input = (orgId: string) => ({
  orgId,
  difficulty: "medium" as const,
  taskType: "feature" as const,
});

test("rankEngines gives one engine per linked, logged-in runtime", async () => {
  const { db, orgId } = fresh();
  const ranked = await rankEngines(db, input(orgId), agents("claude", "codex", "gemini"));
  expect(ranked.map((e) => e.runtime).sort()).toEqual(["claude", "codex", "gemini"]);
  expect(ranked.every((e) => e.model === null)).toBe(true);
});

test("a runtime that is unlinked or logged out is not ready", async () => {
  const { db } = fresh();
  const base = await agents("claude", "codex", "gemini").agents?.();
  const deps = {
    agents: () =>
      Promise.resolve(
        (base ?? []).map((a) =>
          a.id === "claude"
            ? { ...a, enabled: false }
            : a.id === "codex"
              ? { ...a, loggedIn: false }
              : a,
        ),
      ),
  };
  expect([...(await readyRuntimes(db, deps))]).toEqual(["gemini"]);
});

test("a runtime whose quota window is full is skipped, until it has room again", async () => {
  const { db, orgId } = fresh();
  const window = {
    provider: "claude",
    window: "five_hour",
    resetsAt: 9e12,
    source: "manual" as const,
  };
  recordQuota(db, { ...window, usedPercent: 100, ts: Date.now() - 2000 });
  const deps = agents("claude", "codex");
  expect((await rankEngines(db, input(orgId), deps)).map((e) => e.runtime)).toEqual(["codex"]);
  recordQuota(db, { ...window, usedPercent: 40, ts: Date.now() - 1000 });
  expect((await rankEngines(db, input(orgId), deps)).map((e) => e.runtime).sort()).toEqual([
    "claude",
    "codex",
  ]);
});

test("a full window on another account does not take the runtime out of the ranking", async () => {
  const { db, orgId } = fresh();
  const window = {
    provider: "claude",
    window: "five_hour",
    resetsAt: 9e12,
    source: "manual" as const,
  };
  recordQuota(db, { ...window, accountId: "acct-a", usedPercent: 100 });
  recordQuota(db, { ...window, usedPercent: 30 });
  const deps = agents("claude", "codex");
  expect((await rankEngines(db, input(orgId), deps)).map((e) => e.runtime).sort()).toEqual([
    "claude",
    "codex",
  ]);
});

test("the org's allowed runtimes limit the ranking", async () => {
  const { db, orgId } = fresh();
  setPolicy(db, {
    layer: "org",
    targetId: orgId,
    key: "router.allowedRuntimes",
    value: ["codex"],
    setBy: "u1",
  });
  const ranked = await rankEngines(db, input(orgId), agents("claude", "codex"));
  expect(ranked.map((e) => e.runtime)).toEqual(["codex"]);
});
