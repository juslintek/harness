import type { DashboardTask } from "@shared/tracking";
import type { JSX } from "solid-js";
import { StatusBadge } from "../../ui/atoms";

const cell = (value: number | null): string => (value === null ? "-" : String(value));

export function TaskRow(props: { task: DashboardTask }): JSX.Element {
  const t = (): DashboardTask => props.task;
  return (
    <tr>
      <th scope="row">
        <span class="mono muted">#{t().number}</span> {t().title}
      </th>
      <td data-label="Status">
        <StatusBadge kind="task" value={t().status} />
      </td>
      <td data-label="Assignee">{t().assignee ?? "-"}</td>
      <td data-label="Planner est. (min)">{cell(t().plannerMinutes)}</td>
      <td data-label="Reviewer est. (min)">{cell(t().reviewerMinutes)}</td>
      <td data-label="Agent active (min)">{t().agentActiveMinutes}</td>
    </tr>
  );
}
