import { useState } from "preact/hooks";
import { dashboardViewSchema } from "../../../shared/tracking";
import { api, useLoad, useTopic } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { OrgGate } from "../orgs/org-data";
import { Budgets, MemberTable, Quota, TaskTable } from "./dashboard-parts";

const DAY_MS = 86_400_000;

type Range = "today" | "week" | "month";

function sinceOf(range: Range, now: number): number {
  const d = new Date(now);
  if (range === "today") return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (range === "week") return now - 7 * DAY_MS;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function Dashboard({ org }: { org: { id: string; slug: string } }): preact.JSX.Element {
  const [range, setRange] = useState<Range>("month");
  const view = useLoad(
    () =>
      api(
        `/api/orgs/${org.slug}/dashboard?since=${sinceOf(range, Date.now())}`,
        dashboardViewSchema,
      ),
    [org.slug, range],
  );
  useTopic(`org:${org.id}`, () => view.reload());
  return (
    <section>
      <h2>Dashboard</h2>
      <label class="inline">
        Range
        <select value={range} onChange={(e) => setRange(e.currentTarget.value as Range)}>
          <option value="today">Today</option>
          <option value="week">Last 7 days</option>
          <option value="month">This month</option>
        </select>
      </label>
      <ErrorLine message={view.error} />
      {view.data ? (
        <>
          <h3>Members</h3>
          <MemberTable members={view.data.members} />
          <h3>Budgets</h3>
          <Budgets budgets={view.data.budgets} members={view.data.members} />
          <h3>Quota</h3>
          <Quota quota={view.data.quota} />
          <h3>Tasks</h3>
          <TaskTable tasks={view.data.tasks} />
        </>
      ) : (
        !view.error && <p class="muted">Loading...</p>
      )}
    </section>
  );
}

export function DashboardPage({ slug }: { slug: string }): preact.JSX.Element {
  return <OrgGate slug={slug}>{(org) => <Dashboard org={org} />}</OrgGate>;
}
