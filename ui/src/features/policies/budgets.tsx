import { type BudgetScopeKind, type BudgetView, budgetListSchema } from "@shared/budgets";
import type { OrgDetail } from "@shared/orgs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ignored } from "../../auth/me";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { Meter } from "../../ui/meter";
import { Button, Field, Panel, StatusBadge, type Tone } from "../../ui/primitives";
import { FormError } from "../orgs/shared";

const STATE_TONE: Record<BudgetView["state"], Tone> = {
  ok: "success",
  warn: "warning",
  paused: "danger",
};

function scopeName(b: BudgetView, detail: OrgDetail): string {
  if (b.scopeKind === "org") return "Whole org";
  const list =
    b.scopeKind === "team"
      ? detail.teams
      : detail.members.map((m) => ({ id: m.id, name: m.handle }));
  const name = list.find((x) => x.id === b.scopeId)?.name ?? b.scopeId;
  return `${b.scopeKind === "team" ? "Team" : "Member"} ${name}`;
}

interface Initial {
  kind: BudgetScopeKind;
  id: string;
  usd: string;
}

function BudgetForm(props: {
  detail: OrgDetail;
  initial: Initial;
  onDone: () => void;
}): JSX.Element {
  const [kind, setKind] = createSignal(props.initial.kind);
  const [id, setId] = createSignal(props.initial.id);
  const [usd, setUsd] = createSignal(props.initial.usd);
  const action = createAction();
  const options = (): { id: string; label: string }[] =>
    kind() === "team"
      ? props.detail.teams.map((t) => ({ id: t.id, label: t.name }))
      : props.detail.members.map((m) => ({ id: m.id, label: m.handle }));
  const pick = (next: BudgetScopeKind): void => {
    setKind(next);
    setId((next === "team" ? props.detail.teams[0]?.id : props.detail.members[0]?.id) ?? "");
  };
  return (
    <form
      class="form-row"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          const scopeId = kind() === "org" ? props.detail.org.id : id();
          const body = { scopeKind: kind(), scopeId, monthlyUsd: Number(usd()) };
          await api(`/api/orgs/${props.detail.org.slug}/budgets`, ignored, { method: "PUT", body });
          props.onDone();
        });
      }}
    >
      <Field label="Budget scope">
        {(c) => (
          <select {...c()} onChange={(e) => pick(e.currentTarget.value as BudgetScopeKind)}>
            <option value="org" selected={kind() === "org"}>
              Whole org
            </option>
            <option value="team" selected={kind() === "team"}>
              Team
            </option>
            <option value="member" selected={kind() === "member"}>
              Member
            </option>
          </select>
        )}
      </Field>
      <Show when={kind() !== "org"}>
        <Field label="Budget target">
          {(c) => (
            <select {...c()} onChange={(e) => setId(e.currentTarget.value)}>
              <For each={options()}>
                {(o) => (
                  <option value={o.id} selected={o.id === id()}>
                    {o.label}
                  </option>
                )}
              </For>
            </select>
          )}
        </Field>
      </Show>
      <Field label="Monthly limit (USD)" error={action.error()}>
        {(c) => (
          <input
            {...c()}
            type="number"
            min="0.01"
            step="0.01"
            required
            value={usd()}
            onInput={(e) => setUsd(e.currentTarget.value)}
          />
        )}
      </Field>
      <Button type="submit" tone="primary" disabled={action.busy()}>
        Save budget
      </Button>
    </form>
  );
}

function BudgetItem(props: {
  budget: BudgetView;
  detail: OrgDetail;
  onEdit: () => void;
  onChanged: () => void;
}): JSX.Element {
  const action = createAction();
  const [confirming, setConfirming] = createSignal(false);
  const name = (): string => scopeName(props.budget, props.detail);
  const pct = (): number => props.budget.ratio * 100;
  return (
    <li class="policy-card">
      <div class="policy-head">
        <span class="policy-value">{name()}</span>
        <StatusBadge tone={STATE_TONE[props.budget.state]} value={props.budget.state} />
        <Show when={props.budget.unpriced > 0}>
          <span class="muted-line">+ {props.budget.unpriced} unpriced</span>
        </Show>
      </div>
      <Meter
        tone={STATE_TONE[props.budget.state]}
        label={`$${props.budget.spentUsd.toFixed(2)} of $${props.budget.monthlyUsd.toFixed(2)}`}
        value={`${Math.round(pct())}%`}
        pct={pct()}
      />
      <div class="row-actions">
        <Button size="sm" aria-label={`Edit budget for ${name()}`} onClick={props.onEdit}>
          Edit
        </Button>
        <Button
          size="sm"
          tone="danger"
          aria-label={`Delete budget for ${name()}`}
          disabled={action.busy()}
          onClick={() => setConfirming(true)}
        >
          Delete
        </Button>
      </div>
      <FormError message={action.error()} />
      <ConfirmDialog
        open={confirming()}
        title={`Delete the budget for ${name()}?`}
        message="Spending in this scope is no longer limited by this budget."
        confirm="Delete budget"
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void action.run(async () => {
            await api(`/api/orgs/${props.detail.org.slug}/budgets/${props.budget.id}`, ignored, {
              method: "DELETE",
            });
            props.onChanged();
          });
        }}
      />
    </li>
  );
}

export function Budgets(props: { detail: OrgDetail }): JSX.Element {
  const list = createLoad(`/api/orgs/${props.detail.org.slug}/budgets`, budgetListSchema);
  // A new object per edit remounts the form, which reloads its fields from the chosen budget.
  const [form, setForm] = createSignal<Initial>({ kind: "org", id: "", usd: "" });
  const reload = (): void => void list.reload();
  return (
    <Panel title="Budgets">
      <div class="stack">
        <FormError message={list.error()} />
        <Show when={list.data()?.length === 0}>
          <p class="muted-line">No budgets set.</p>
        </Show>
        <ul class="card-list">
          <For each={list.data()}>
            {(b) => (
              <BudgetItem
                budget={b}
                detail={props.detail}
                onEdit={() =>
                  setForm({ kind: b.scopeKind, id: b.scopeId, usd: String(b.monthlyUsd) })
                }
                onChanged={reload}
              />
            )}
          </For>
        </ul>
        <Show when={form()} keyed>
          {(initial) => <BudgetForm detail={props.detail} initial={initial} onDone={reload} />}
        </Show>
      </div>
    </Panel>
  );
}
