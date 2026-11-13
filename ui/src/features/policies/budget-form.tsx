import type { BudgetScopeKind } from "@shared/budgets";
import type { OrgDetail } from "@shared/orgs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ignored } from "../../auth/me";
import { createAction } from "../../ui/action";
import { Button, Help } from "../../ui/atoms";
import { Field } from "../../ui/molecules";

export interface BudgetInitial {
  kind: BudgetScopeKind;
  id: string;
  usd: string;
}

export function BudgetForm(props: {
  detail: OrgDetail;
  initial: BudgetInitial;
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
      id="budget-form"
      class="stack budget-form"
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
      <h3 class="sub-title">Set or change a budget</h3>
      <div class="form-row">
        <Field label="Applies to">
          {(c) => (
            <select {...c()} onChange={(e) => pick(e.currentTarget.value as BudgetScopeKind)}>
              <option value="org" selected={kind() === "org"}>
                Whole organisation
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
          <Field label="Name">
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
      </div>
      <Help>
        Saving a limit that already exists for the same target replaces it. Saving asks for your
        passkey.
      </Help>
    </form>
  );
}
