import { expect, test } from "bun:test";
import type { AccountView } from "../../../shared/accounts";
import {
  addAccountWithLogin,
  formatQuotaAge,
  mapAccountRows,
  poolSummary,
  removeAccountConfirmed,
} from "../../../shared/accounts-ui";
import type { QuotaRow } from "../../../shared/runs";

const NOW = 1_700_000_000_000;

function acct(over: Partial<AccountView> = {}): AccountView {
  return {
    id: "acct-a",
    runtime: "codex",
    kind: "login",
    label: "work",
    home: "/h/accounts/acct-a",
    state: "active",
    identityHint: "Pro plan",
    maxConcurrent: 1,
    priority: 0,
    exhaustedUntil: null,
    lastProbeAt: NOW - 60_000,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function quota(over: Partial<QuotaRow> = {}): QuotaRow {
  return {
    provider: "codex",
    accountId: "acct-a",
    window: "primary",
    usedPercent: 35,
    resetsAt: NOW + 3_600_000,
    source: "probe",
    ts: NOW - 5 * 60_000,
    ...over,
  };
}

test("maps two accounts under one runtime with state, identity hint, and quota bars with age or unknown", () => {
  const accounts = [
    acct({ id: "acct-a", label: "work", identityHint: "Pro" }),
    acct({ id: "acct-b", label: "personal", state: "unknown", identityHint: null }),
  ];
  const rows = mapAccountRows(accounts, [quota({ accountId: "acct-a", usedPercent: 35 })], NOW);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    id: "acct-a",
    label: "work",
    state: "active",
    identityHint: "Pro",
    quotaUnknown: false,
  });
  expect(rows[0]?.windows[0]).toMatchObject({
    window: "primary",
    usedPercent: 35,
    ageLabel: "5m ago",
  });
  expect(rows[1]).toMatchObject({
    id: "acct-b",
    label: "personal",
    state: "unknown",
    identityHint: null,
    quotaUnknown: true,
    windows: [],
  });
  expect(formatQuotaAge(NOW - 20_000, NOW)).toBe("just now");
  expect(formatQuotaAge(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
});

test("poolSummary picks the next eligible account by headroom and counts exhausted accounts", () => {
  const accounts = [
    acct({ id: "acct-a", label: "work" }),
    acct({ id: "acct-b", label: "backup" }),
    acct({ id: "acct-c", label: "full", exhaustedUntil: NOW + 60_000 }),
  ];
  const summary = poolSummary(
    "codex",
    accounts,
    [
      quota({ accountId: "acct-a", usedPercent: 70 }),
      quota({ accountId: "acct-b", usedPercent: 20 }),
    ],
    NOW,
  );
  expect(summary.nextAccountId).toBe("acct-b");
  expect(summary.nextLabel).toBe("backup");
  expect(summary.eligibleCount).toBe(2);
  expect(summary.exhaustedCount).toBe(1);
});

test("addAccountWithLogin creates the account and yields the login command", async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const created = acct({ id: "new-1", label: "team-b", state: "pending" });
  const fakeApi = async (
    path: string,
    init: { method: "POST" | "DELETE"; body?: unknown },
  ): Promise<unknown> => {
    calls.push({ path, ...init });
    if (path.endsWith("/accounts")) return created;
    return { command: ["codex", "login"] };
  };
  const result = await addAccountWithLogin(fakeApi, "codex", "team-b");
  expect(result.account.id).toBe("new-1");
  expect(result.command).toBe("codex login");
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
    "POST /api/agents/codex/accounts",
    "POST /api/agents/codex/accounts/new-1/login",
  ]);
});

test("removeAccountConfirmed requires explicit confirmation and propagates step_up_required", async () => {
  let called = 0;
  const fakeApi = async (): Promise<unknown> => {
    called++;
    throw new Error("step_up_required");
  };
  const unconfirmed = await removeAccountConfirmed(fakeApi, "codex", "acct-a", false, false);
  expect(unconfirmed).toEqual({ ok: false, reason: "confirmation_required" });
  expect(called).toBe(0);

  await expect(removeAccountConfirmed(fakeApi, "codex", "acct-a", true, true)).rejects.toThrow(
    "step_up_required",
  );
  expect(called).toBe(1);
});
