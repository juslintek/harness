import type { BudgetView } from "@shared/budgets";
import type { OrgDetail } from "@shared/orgs";
import { type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ignored } from "../../auth/me";
import { createAction } from "../../ui/action";
import { Button, Help, StatusBadge } from "../../ui/atoms";
import { BudgetMeter, ConfirmButton } from "../../ui/molecules";
import { FormError } from "../orgs/shared";

export function scopeName(b: BudgetView, detail: OrgDetail): string {
  if (b.scopeKind === "org") return "Whole organisation";
  const list =
    b.scopeKind === "team"
      ? detail.teams
      : detail.members.map((m) => ({ id: m.id, name: m.handle }));
  const name = list.find((x) => x.id === b.scopeId)?.name ?? b.scopeId;
  return `${b.scopeKind === "team" ? "Team" : "Member"} ${name}`;
}

export function BudgetRow(props: {
  budget: BudgetView;
  detail: OrgDetail;
  onEdit: () => void;
  onChanged: () => void;
}): JSX.Element {
  const action = createAction();
  const name = (): string => scopeName(props.budget, props.detail);
  const one = (): boolean => props.budget.unpriced === 1;
  return (
    <li class="policy-card">
      <div class="policy-head">
        <span class="policy-name">{name()}</span>
        <StatusBadge kind="budget" value={props.budget.state} />
      </div>
      <BudgetMeter budget={props.budget} />
      <Show when={props.budget.unpriced > 0}>
        <Help>
          {`${props.budget.unpriced} ${one() ? "run has" : "runs had"} no price (unknown model) and ${one() ? "is" : "are"} not counted`}
        </Help>
      </Show>
      <div class="row-actions">
        <Show when={props.budget.state === "paused"}>
          <Button size="sm" aria-label={`Raise limit for ${name()}`} onClick={props.onEdit}>
            Raise limit
          </Button>
        </Show>
        <Button size="sm" aria-label={`Edit budget for ${name()}`} onClick={props.onEdit}>
          Edit
        </Button>
        <ConfirmButton
          size="sm"
          text="Delete"
          label={`Delete budget for ${name()}`}
          disabled={action.busy()}
          title={`Delete the budget for ${name()}?`}
          message="Spending in this scope is no longer limited by this budget."
          confirm="Delete budget"
          onConfirm={() =>
            void action.run(async () => {
              await api(`/api/orgs/${props.detail.org.slug}/budgets/${props.budget.id}`, ignored, {
                method: "DELETE",
              });
              props.onChanged();
            })
          }
        />
      </div>
      <FormError message={action.error()} />
    </li>
  );
}
