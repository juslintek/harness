import type { BudgetView } from "@shared/budgets";
import type { MemberReport } from "@shared/tracking";
import { dashboardViewSchema } from "@shared/tracking";
import { createSignal, For, type JSX, Show } from "solid-js";
import { me } from "../../auth/me";
import { createLoad } from "../../load";
import { Help } from "../../ui/atoms";
import { Field, Panel, State, TableBox } from "../../ui/molecules";
import { BudgetRow } from "./budget-row";
import { MemberRow } from "./member-row";
import { QuotaRow } from "./quota-row";
import { SpendLine } from "./spend-line";
import { TaskRow } from "./task-row";
import "./dashboard.css";

const DAY_MS = 86_400_000;
type Range = "today" | "week" | "month";

function sinceOf(range: Range, now: number): number {
  const d = new Date(now);
  if (range === "today") return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (range === "week") return now - 7 * DAY_MS;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

const ORDER = { paused: 0, warn: 1, ok: 2 } as const;

function scopeName(b: BudgetView, members: MemberReport[], orgName: string): string {
  if (b.scopeKind === "member") {
    return members.find((m) => m.memberId === b.scopeId)?.handle ?? "member";
  }
  return b.scopeKind === "org" ? orgName : "Team";
}

function Dashboard(props: { org: { id: string; slug: string; name: string } }): JSX.Element {
  const [range, setRange] = createSignal<Range>("month");
  const view = createLoad(
    () => `/api/orgs/${props.org.slug}/dashboard?since=${sinceOf(range(), Date.now())}`,
    dashboardViewSchema,
    [`org:${props.org.id}`],
  );
  return (
    <div class="dashboard">
      <Show when={view.error()}>
        {(message) => <State kind="error" message={message()} onRetry={() => void view.reload()} />}
      </Show>
      <Show when={view.loading()}>
        <State kind="loading" />
      </Show>
      <Show when={view.data()}>
        {(data) => {
          const name = (b: BudgetView): string => scopeName(b, data().members, props.org.name);
          const budgets = (): BudgetView[] =>
            [...data().budgets].sort((a, b) => ORDER[a.state] - ORDER[b.state]);
          return (
            <>
              <SpendLine
                budgets={data().budgets}
                quota={data().quota}
                name={name}
                slug={props.org.slug}
              />
              <div class="dashboard-pair">
                <Panel title="Budgets">
                  <Help>
                    A budget is a monthly spending limit in USD. It counts the calendar month (UTC).
                    At 80% the budget shows near limit. At 100% it is paused.
                  </Help>
                  <Show
                    when={budgets().length > 0}
                    fallback={<p class="dashboard-empty">No budgets set.</p>}
                  >
                    <ul class="dashboard-stack">
                      <For each={budgets()}>
                        {(b) => <BudgetRow budget={b} name={name(b)} slug={props.org.slug} />}
                      </For>
                    </ul>
                  </Show>
                </Panel>
                <Panel title="Provider quota">
                  <Help>
                    Quota is the limit your AI provider sets, in percent of a time window. It is
                    separate from budgets and does not depend on the range.
                  </Help>
                  <Show
                    when={data().quota.length > 0}
                    fallback={<p class="dashboard-empty">No quota data.</p>}
                  >
                    <ul class="dashboard-stack">
                      <For each={data().quota}>{(q) => <QuotaRow quota={q} />}</For>
                    </ul>
                  </Show>
                </Panel>
              </div>
              <div class="dashboard-head">
                <Help>
                  Budgets and quota are always shown for now. The range changes only the two tables
                  below.
                </Help>
                <Field label="Range for members and tasks">
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
              <Panel title="Members">
                <TableBox stack label="Usage per member">
                  <thead>
                    <tr>
                      <th scope="col">Member</th>
                      <th scope="col">Runs done</th>
                      <th scope="col">Tokens in</th>
                      <th scope="col">Tokens out</th>
                      <th scope="col">Cost (USD)</th>
                      <th scope="col">Active (min)</th>
                      <th scope="col">Waiting (min)</th>
                      <th scope="col">Wall (min)</th>
                      <th scope="col">Top tools (calls)</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={data().members}>{(m) => <MemberRow member={m} />}</For>
                  </tbody>
                </TableBox>
                <Help>
                  Active: time an agent worked. Waiting: time a run waited for a person. Wall: first
                  to last event of the run. ~ means the cost is an estimate from the price list.
                </Help>
              </Panel>
              <Panel title="Tasks">
                <Show
                  when={data().tasks.length > 0}
                  fallback={<p class="dashboard-empty">No tasks changed in this range.</p>}
                >
                  <TableBox stack label="Tasks with estimates and agent time">
                    <thead>
                      <tr>
                        <th scope="col">Task</th>
                        <th scope="col">Status</th>
                        <th scope="col">Assignee</th>
                        <th scope="col">Planner est. (min)</th>
                        <th scope="col">Reviewer est. (min)</th>
                        <th scope="col">Agent active (min)</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={data().tasks}>{(t) => <TaskRow task={t} />}</For>
                    </tbody>
                  </TableBox>
                </Show>
              </Panel>
            </>
          );
        }}
      </Show>
    </div>
  );
}

export function DashboardPage(props: { slug: string }): JSX.Element {
  const org = (): { id: string; slug: string; name: string } | undefined =>
    me()?.orgs.find((o) => o.slug === props.slug);
  return (
    <Show when={org()} fallback={<State kind="empty" message="Org not found" />}>
      {(found) => <Dashboard org={found()} />}
    </Show>
  );
}
