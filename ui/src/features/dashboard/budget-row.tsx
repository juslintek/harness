import type { BudgetView } from "@shared/budgets";
import { type JSX, Show } from "solid-js";
import { ButtonLink, StatusBadge } from "../../ui/atoms";
import { BudgetMeter } from "../../ui/molecules";

const KIND = { org: "Organisation", team: "Team", member: "Member" } as const;

export function budgetPercent(b: BudgetView): number {
  return Math.round(b.ratio * 100);
}

export function BudgetRow(props: { budget: BudgetView; name: string; slug: string }): JSX.Element {
  return (
    <li class="dashboard-item">
      <div class="dashboard-row">
        <span>
          {props.name} <span class="dashboard-note">{KIND[props.budget.scopeKind]}</span>{" "}
          <StatusBadge kind="budget" value={props.budget.state} />
        </span>
        <Show when={props.budget.state !== "ok"}>
          <ButtonLink size="sm" href={`#/o/${props.slug}/policies`}>
            Change limit
          </ButtonLink>
        </Show>
      </div>
      <BudgetMeter budget={props.budget} />
      <Show when={props.budget.state === "paused"}>
        <p class="dashboard-note">
          Runs of this budget were stopped and new wake-ups are skipped until the limit is raised or
          the month ends.
        </p>
      </Show>
      <Show when={props.budget.unpriced > 0}>
        <p class="dashboard-note">
          {props.budget.unpriced} events have no price and count as $0.00.
        </p>
      </Show>
    </li>
  );
}
