import { type AccountView, accountEnvFor } from "./accounts";
import { QUOTA_PROVIDER } from "./router";
import type { QuotaRow } from "./runs";

interface QuotaBarView {
  window: string;
  usedPercent: number;
  ageLabel: string;
  resetsAt: number | null;
}

export interface AccountRowView {
  id: string;
  runtime: string;
  label: string;
  home: string | null;
  state: AccountView["state"];
  identityHint: string | null;
  isDefault: boolean;
  enabled: boolean;
  exhausted: boolean;
  exhaustedUntil: number | null;
  quotaUnknown: boolean;
  windows: QuotaBarView[];
}

export interface PoolRuntimeSummary {
  runtime: string;
  totalCount: number;
  eligibleCount: number;
  exhaustedCount: number;
  nextAccountId: string | null;
  nextLabel: string | null;
}

const USABLE = new Set<AccountView["state"]>(["active", "unknown"]);

export function formatQuotaAge(ts: number, now: number = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function mapAccountRows(
  accounts: AccountView[],
  quota: QuotaRow[],
  now: number = Date.now(),
): AccountRowView[] {
  return accounts
    .filter((a) => a.state !== "removed")
    .map((a) => {
      const provider = QUOTA_PROVIDER[a.runtime];
      const windows: QuotaBarView[] = quota
        .filter((q) => q.provider === provider && q.accountId === a.id && q.usedPercent !== null)
        .map((q) => ({
          window: q.window,
          usedPercent: q.usedPercent as number,
          ageLabel: formatQuotaAge(q.ts, now),
          resetsAt: q.resetsAt,
        }));
      const byWindow = windows.some((w) => w.usedPercent >= 100);
      const byCooldown = a.exhaustedUntil !== null && a.exhaustedUntil > now;
      return {
        id: a.id,
        runtime: a.runtime,
        label: a.label,
        home: a.home,
        state: a.state,
        identityHint: a.identityHint,
        isDefault: a.home === null,
        enabled: a.state !== "disabled" && a.state !== "removing",
        exhausted: byWindow || byCooldown,
        exhaustedUntil: byCooldown ? a.exhaustedUntil : null,
        quotaUnknown: windows.length === 0,
        windows,
      };
    });
}

export function poolSummary(
  runtime: string,
  accounts: AccountView[],
  quota: QuotaRow[],
  now: number = Date.now(),
): PoolRuntimeSummary {
  const rows = mapAccountRows(
    accounts.filter((a) => a.runtime === runtime),
    quota,
    now,
  );
  const usable = rows.filter((r) => USABLE.has(r.state));
  const exhausted = usable.filter((r) => r.exhausted);
  const eligible = usable.filter((r) => !r.exhausted);
  const headroom = (r: AccountRowView): number =>
    r.windows.length === 0 ? 0.5 : 1 - Math.max(...r.windows.map((w) => w.usedPercent)) / 100;
  const best = [...eligible].sort(
    (a, b) => headroom(b) - headroom(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0];
  return {
    runtime,
    totalCount: rows.length,
    eligibleCount: eligible.length,
    exhaustedCount: exhausted.length,
    nextAccountId: best?.id ?? null,
    nextLabel: best?.label ?? null,
  };
}

export type JsonCaller = (
  path: string,
  init: { method: "POST" | "DELETE"; body?: unknown },
) => Promise<unknown>;

function shellQuote(arg: string): string {
  if (arg.length > 0 && /^[A-Za-z0-9_./:@+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function formatAccountLoginCommand(
  runtime: string,
  home: string | null,
  command: string[],
): string {
  const envParts = Object.entries(accountEnvFor(runtime, home)).map(
    ([key, value]) => `${key}=${shellQuote(value)}`,
  );
  return [...envParts, ...command.map(shellQuote)].join(" ");
}

export async function loginAccount(
  call: JsonCaller,
  account: Pick<AccountView, "id" | "runtime" | "home">,
): Promise<string> {
  const login = (await call(
    `/api/agents/${encodeURIComponent(account.runtime)}/accounts/${encodeURIComponent(account.id)}/login`,
    { method: "POST", body: {} },
  )) as { command: string[] };
  return formatAccountLoginCommand(account.runtime, account.home, login.command);
}

export async function addAccountWithLogin(
  call: JsonCaller,
  runtime: string,
  label: string,
): Promise<{ account: AccountView; command: string | null; loginError: string | null }> {
  const account = (await call(`/api/agents/${encodeURIComponent(runtime)}/accounts`, {
    method: "POST",
    body: { label: label.trim() },
  })) as AccountView;
  try {
    return { account, command: await loginAccount(call, account), loginError: null };
  } catch (err) {
    return {
      account,
      command: null,
      loginError: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function removeAccountConfirmed(
  call: JsonCaller,
  runtime: string,
  accountId: string,
  confirmed: boolean,
  drain: boolean,
): Promise<{ ok: true } | { ok: false; reason: "confirmation_required" }> {
  if (!confirmed) return { ok: false, reason: "confirmation_required" };
  const qs = drain ? "?drain=1" : "";
  await call(
    `/api/agents/${encodeURIComponent(runtime)}/accounts/${encodeURIComponent(accountId)}${qs}`,
    { method: "DELETE" },
  );
  return { ok: true };
}
