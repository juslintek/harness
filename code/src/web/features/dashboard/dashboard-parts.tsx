import type { BudgetView } from "../../../shared/budgets";
import type { DashboardTask, MemberReport, QuotaWindow } from "../../../shared/tracking";
import { fmtTime } from "../../format";

const nf = new Intl.NumberFormat("en");
const minutes = (ms: number): string => `${nf.format(Math.round(ms / 60_000))} min`;
const share = (value: number, max: number): number =>
  max > 0 ? Math.min(100, (value / max) * 100) : 0;

// A "~" marks a cost the registry priced; unpriced events are listed so a low total is not read as final.
function Cost({ m }: { m: MemberReport }): preact.JSX.Element {
  const usd = `${m.costEstimated ? "~" : ""}$${m.costUsd.toFixed(2)}`;
  return (
    <>
      {usd}
      {m.unpricedEvents > 0 && <small class="muted"> + {m.unpricedEvents} unpriced</small>}
    </>
  );
}

function Bar({ pct, kind }: { pct: number; kind: string }): preact.JSX.Element {
  return (
    <span class="bar" aria-hidden="true">
      <span class={`bar-fill ${kind}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

function MemberRow({
  m,
  maxTokens,
  maxWall,
}: {
  m: MemberReport;
  maxTokens: number;
  maxWall: number;
}): preact.JSX.Element {
  return (
    <tr>
      <th scope="row">{m.handle}</th>
      <td data-label="Runs">
        {m.completed} / {m.runs} done
      </td>
      <td data-label="Tokens in / out">
        <span>
          {nf.format(m.inputTokens)} / {nf.format(m.outputTokens)}
          <Bar pct={share(m.inputTokens + m.outputTokens, maxTokens)} kind="tokens" />
        </span>
      </td>
      <td data-label="Cost">
        <span>
          <Cost m={m} />
        </span>
      </td>
      <td data-label="Active / waiting / wall">
        <span>
          {minutes(m.activeMs)} / {minutes(m.waitingMs)} / {minutes(m.wallMs)}
          <Bar pct={share(m.wallMs, maxWall)} kind="time" />
        </span>
      </td>
      <td data-label="Estimate vs actual (done tasks only)">
        planner {m.plannerMinutes} min, reviewer {m.reviewerMinutes} min, actual{" "}
        {minutes(m.activeMs)}
      </td>
      <td data-label="Top tools">
        {m.tools.map((t) => `${t.name} (${t.count})`).join(", ") || "-"}
      </td>
      <td data-label="Stack">{m.stack.join(", ") || "-"}</td>
    </tr>
  );
}

export function MemberTable({ members }: { members: MemberReport[] }): preact.JSX.Element {
  const maxTokens = Math.max(0, ...members.map((m) => m.inputTokens + m.outputTokens));
  const maxWall = Math.max(0, ...members.map((m) => m.wallMs));
  return (
    <table class="stack dashboard-table">
      <caption class="sr-only">Usage per member</caption>
      <thead>
        <tr>
          <th scope="col">Member</th>
          <th scope="col">Runs</th>
          <th scope="col">Tokens in / out</th>
          <th scope="col">Cost</th>
          <th scope="col">Active / waiting / wall</th>
          <th scope="col">Estimate vs actual (done tasks only)</th>
          <th scope="col">Top tools</th>
          <th scope="col">Stack</th>
        </tr>
      </thead>
      <tbody>
        {members.map((m) => (
          <MemberRow key={m.memberId} m={m} maxTokens={maxTokens} maxWall={maxWall} />
        ))}
      </tbody>
    </table>
  );
}

function scopeName(b: BudgetView, members: MemberReport[]): string {
  if (b.scopeKind === "member") {
    return members.find((m) => m.memberId === b.scopeId)?.handle ?? "member";
  }
  return b.scopeKind === "org" ? "Whole org" : "Team";
}

const STATE_TEXT = { ok: "ok", warn: "warning, 80% reached", paused: "paused, limit reached" };

export function Budgets({
  budgets,
  members,
}: {
  budgets: BudgetView[];
  members: MemberReport[];
}): preact.JSX.Element {
  if (budgets.length === 0) return <p class="muted">No budgets set.</p>;
  return (
    <ul class="budget-list">
      {budgets.map((b) => (
        <li key={b.id}>
          <strong>{scopeName(b, members)}</strong>: ${b.spentUsd.toFixed(2)} of $
          {b.monthlyUsd.toFixed(2)} ({Math.round(b.ratio * 100)}%), status{" "}
          <span class={`budget-state ${b.state}`}>{STATE_TEXT[b.state]}</span>
          <Bar pct={share(b.spentUsd, b.monthlyUsd)} kind={b.state} />
        </li>
      ))}
    </ul>
  );
}

export function Quota({ quota }: { quota: QuotaWindow[] }): preact.JSX.Element {
  return (
    <ul class="budget-list">
      {quota.map((q) => (
        <li key={`${q.provider}/${q.window}`}>
          <strong>{q.provider}</strong> {q.window === "unknown" ? "" : `${q.window}: `}
          {q.usedPercent === null
            ? "no data yet"
            : `${Math.round(q.usedPercent)}% used, resets ${fmtTime(q.resetsAt)}`}
          {q.usedPercent !== null && <Bar pct={q.usedPercent} kind="tokens" />}
        </li>
      ))}
    </ul>
  );
}

const cell = (value: number | null): string => (value === null ? "-" : `${value} min`);

export function TaskTable({ tasks }: { tasks: DashboardTask[] }): preact.JSX.Element {
  if (tasks.length === 0) return <p class="muted">No tasks changed in this range.</p>;
  return (
    <table class="stack dashboard-table">
      <caption class="sr-only">Tasks with estimates and agent time</caption>
      <thead>
        <tr>
          <th scope="col">Task</th>
          <th scope="col">Status</th>
          <th scope="col">Assignee</th>
          <th scope="col">Planner</th>
          <th scope="col">Reviewer</th>
          <th scope="col">Agent active</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((t) => (
          <tr key={t.number}>
            <th scope="row">
              #{t.number} {t.title}
            </th>
            <td data-label="Status">{t.status}</td>
            <td data-label="Assignee">{t.assignee ?? "-"}</td>
            <td data-label="Planner">{cell(t.plannerMinutes)}</td>
            <td data-label="Reviewer">{cell(t.reviewerMinutes)}</td>
            <td data-label="Agent active">{t.agentActiveMinutes} min</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
