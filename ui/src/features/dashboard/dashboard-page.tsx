import type { BudgetView } from "@shared/budgets";
import type { DashboardTask, MemberReport, QuotaWindow } from "@shared/tracking";
import { dashboardViewSchema } from "@shared/tracking";
import { createSignal, For, type JSX, Show } from "solid-js";
import { me } from "../../auth/me";
import { createLoad } from "../../load";
import { TableBox } from "../../ui/data-table";
import { Meter } from "../../ui/meter";
import { Field, Panel, State, StatusBadge, type Tone } from "../../ui/primitives";
import "./dashboard.css";

const DAY_MS = 86_400_000;
type Range = "today" | "week" | "month";

function sinceOf(range: Range, now: number): number {
  const d = new Date(now);
  if (range === "today") return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (range === "week") return now - 7 * DAY_MS;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

const nf = new Intl.NumberFormat("en");
const minutes = (ms: number): string => `${nf.format(Math.round(ms / 60_000))} min`;
const when = (ms: number | null): string => (ms === null ? "-" : new Date(ms).toLocaleString());

const TASK_TONE: Record<string, Tone> = {
  backlog: "neutral",
  todo: "neutral",
  cancelled: "neutral",
  in_progress: "info",
  in_review: "warning",
  done: "success",
  blocked: "danger",
};
const BUDGET_TONE: Record<BudgetView["state"], Tone> = {
  ok: "success",
  warn: "warning",
  paused: "danger",
};

function MemberTable(props: { members: MemberReport[] }): JSX.Element {
  return (
    <TableBox label="Usage per member">
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
        <For each={props.members}>
          {(m) => (
            <tr>
              <th scope="row">{m.handle}</th>
              <td>
                {m.completed} / {m.runs} done
              </td>
              <td class="num">
                {nf.format(m.inputTokens)} / {nf.format(m.outputTokens)}
              </td>
              <td>
                {/* "~" marks a cost the registry priced; unpriced events keep a low total from reading as final. */}
                {m.costEstimated ? "~" : ""}${m.costUsd.toFixed(2)}
                <Show when={m.unpricedEvents > 0}>
                  <span class="dashboard-note"> + {m.unpricedEvents} unpriced</span>
                </Show>
              </td>
              <td>
                {minutes(m.activeMs)} / {minutes(m.waitingMs)} / {minutes(m.wallMs)}
              </td>
              <td>
                planner {m.plannerMinutes} min, reviewer {m.reviewerMinutes} min, actual{" "}
                {minutes(m.activeMs)}
              </td>
              <td class="dashboard-tools">
                {m.tools.map((t) => `${t.name} (${t.count})`).join(", ") || "-"}
              </td>
              <td>{m.stack.join(", ") || "-"}</td>
            </tr>
          )}
        </For>
      </tbody>
    </TableBox>
  );
}

const scopeName = (b: BudgetView, members: MemberReport[]): string =>
  b.scopeKind === "member"
    ? (members.find((m) => m.memberId === b.scopeId)?.handle ?? "member")
    : b.scopeKind === "org"
      ? "Whole org"
      : "Team";

function Budgets(props: { budgets: BudgetView[]; members: MemberReport[] }): JSX.Element {
  return (
    <Show when={props.budgets.length > 0} fallback={<p class="dashboard-empty">No budgets set.</p>}>
      <ul class="dashboard-stack">
        <For each={props.budgets}>
          {(b) => (
            <li>
              <div class="dashboard-row">
                <span>{scopeName(b, props.members)}</span>
                <StatusBadge tone={BUDGET_TONE[b.state]} value={b.state} />
              </div>
              <Meter
                tone={BUDGET_TONE[b.state]}
                label={`$${b.spentUsd.toFixed(2)} of $${b.monthlyUsd.toFixed(2)}`}
                value={`${Math.round(b.ratio * 100)}%`}
                pct={b.monthlyUsd > 0 ? (b.spentUsd / b.monthlyUsd) * 100 : 0}
              />
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

function QuotaRow(props: { q: QuotaWindow }): JSX.Element {
  const used = (): number | null => props.q.usedPercent;
  return (
    <li>
      <div class="dashboard-row">
        <span>
          {props.q.provider}
          <Show when={props.q.window !== "unknown"}>
            <span class="dashboard-note"> {props.q.window}</span>
          </Show>
        </span>
      </div>
      <Show when={used() !== null} fallback={<span class="dashboard-note">no data yet</span>}>
        <Meter
          tone={(used() ?? 0) >= 80 ? "warning" : "success"}
          label={`${Math.round(used() ?? 0)}% used`}
          value={`resets ${when(props.q.resetsAt)}`}
          pct={used() ?? 0}
        />
      </Show>
    </li>
  );
}

function Quota(props: { quota: QuotaWindow[] }): JSX.Element {
  return (
    <Show when={props.quota.length > 0} fallback={<p class="dashboard-empty">No quota data.</p>}>
      <ul class="dashboard-stack">
        <For each={props.quota}>{(q) => <QuotaRow q={q} />}</For>
      </ul>
    </Show>
  );
}

const cell = (value: number | null): string => (value === null ? "-" : `${value} min`);

function TaskTable(props: { tasks: DashboardTask[] }): JSX.Element {
  return (
    <Show
      when={props.tasks.length > 0}
      fallback={<p class="dashboard-empty">No tasks changed in this range.</p>}
    >
      <TableBox label="Tasks with estimates and agent time">
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
          <For each={props.tasks}>
            {(t) => (
              <tr>
                <th scope="row">
                  <span class="mono muted">#{t.number}</span> {t.title}
                </th>
                <td>
                  <StatusBadge tone={TASK_TONE[t.status] ?? "neutral"} value={t.status} />
                </td>
                <td>{t.assignee ?? "-"}</td>
                <td>{cell(t.plannerMinutes)}</td>
                <td>{cell(t.reviewerMinutes)}</td>
                <td>{t.agentActiveMinutes} min</td>
              </tr>
            )}
          </For>
        </tbody>
      </TableBox>
    </Show>
  );
}

function Dashboard(props: { org: { id: string; slug: string } }): JSX.Element {
  const [range, setRange] = createSignal<Range>("month");
  const view = createLoad(
    () => `/api/orgs/${props.org.slug}/dashboard?since=${sinceOf(range(), Date.now())}`,
    dashboardViewSchema,
    [`org:${props.org.id}`],
  );
  return (
    <div class="dashboard">
      <div class="dashboard-head">
        <Field label="Range">
          {(control) => (
            <select
              {...control()}
              value={range()}
              onChange={(e) => setRange(e.currentTarget.value as Range)}
            >
              <option value="today">Today</option>
              <option value="week">Last 7 days</option>
              <option value="month">This month</option>
            </select>
          )}
        </Field>
      </div>
      <Show when={view.error()}>
        {(message) => <State kind="error" message={message()} onRetry={() => void view.reload()} />}
      </Show>
      <Show when={view.loading()}>
        <State kind="loading" />
      </Show>
      <Show when={view.data()}>
        {(data) => (
          <>
            <Panel title="Members">
              <MemberTable members={data().members} />
            </Panel>
            <div class="dashboard-pair">
              <Panel title="Budgets">
                <Budgets budgets={data().budgets} members={data().members} />
              </Panel>
              <Panel title="Quota">
                <Quota quota={data().quota} />
              </Panel>
            </div>
            <Panel title="Tasks">
              <TaskTable tasks={data().tasks} />
            </Panel>
          </>
        )}
      </Show>
    </div>
  );
}

export function DashboardPage(props: { slug: string }): JSX.Element {
  const org = (): { id: string; slug: string } | undefined =>
    me()?.orgs.find((o) => o.slug === props.slug);
  return (
    <Show when={org()} fallback={<State kind="empty" message="Org not found" />}>
      {(found) => <Dashboard org={found()} />}
    </Show>
  );
}
