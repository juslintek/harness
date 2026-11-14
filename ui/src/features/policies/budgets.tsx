import type { BudgetView } from "@shared/budgets";
import type { OrgDetail } from "@shared/orgs";
import { type Accessor, For, type JSX, Show } from "solid-js";
import { Help } from "../../ui/atoms";
import { Panel } from "../../ui/molecules";
import { BudgetForm, type BudgetInitial } from "./budget-form";
import { BudgetRow } from "./budget-row";

export function summaryLine(list: BudgetView[]): string {
  const paused = list.filter((b) => b.state === "paused").length;
  const org = list.find((b) => b.scopeKind === "org");
  const used = org
    ? `$${org.spentUsd.toFixed(2)} of $${org.monthlyUsd.toFixed(2)} used by the whole organisation (${Math.round(org.ratio * 100)}%). `
    : "No budget covers the whole organisation. ";
  const state =
    paused === 0
      ? "No budget is paused."
      : `${paused} ${paused === 1 ? "budget is" : "budgets are"} paused.`;
  return used + state;
}

export function Budgets(props: {
  detail: OrgDetail;
  list: BudgetView[];
  form: Accessor<BudgetInitial>;
  onEdit: (b: BudgetView) => void;
  onChanged: () => void;
}): JSX.Element {
  return (
    <Panel
      title="Budgets this month"
      actions={<a href={`#/o/${props.detail.org.slug}/dashboard`}>Open Usage &amp; budgets</a>}
    >
      <div class="stack">
        <p class="summary-line">{summaryLine(props.list)}</p>
        <Help>
          At 80% a warning is posted in the org chat. When spending reaches 100% the budget is
          paused: running runs of the people it covers are stopped, and their new wake-ups are
          skipped. It starts again when the month ends (UTC) or when you raise the limit. Only
          priced usage counts.
        </Help>
        <Show when={props.list.length === 0}>
          <p class="muted-line">No budgets set.</p>
        </Show>
        <ul class="card-list">
          <For each={props.list}>
            {(b) => (
              <BudgetRow
                budget={b}
                detail={props.detail}
                onEdit={() => props.onEdit(b)}
                onChanged={props.onChanged}
              />
            )}
          </For>
        </ul>
        {/* A new object per edit remounts the form, which loads its fields from the chosen budget. */}
        <Show when={props.form()} keyed>
          {(initial) => (
            <BudgetForm detail={props.detail} initial={initial} onDone={props.onChanged} />
          )}
        </Show>
      </div>
    </Panel>
  );
}
