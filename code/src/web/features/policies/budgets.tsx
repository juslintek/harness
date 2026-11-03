import { useState } from "preact/hooks";
import {
  type BudgetScopeKind,
  type BudgetState,
  type BudgetView,
  budgetListSchema,
} from "../../../shared/budgets";
import type { OrgDetail } from "../../../shared/orgs";
import { api, useLoad } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { ignored } from "../auth/me";
import { useAction } from "../auth/use-action";

const STATE_TEXT: Record<BudgetState, string> = {
  ok: "ok",
  warn: "warning, 80% reached",
  paused: "paused, limit reached",
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

interface Target {
  kind: BudgetScopeKind;
  id: string;
}

function TargetFields({
  detail,
  target,
  onTarget,
}: {
  detail: OrgDetail;
  target: Target;
  onTarget: (t: Target) => void;
}): preact.JSX.Element {
  const { kind, id } = target;
  const options =
    kind === "team"
      ? detail.teams.map((t) => ({ id: t.id, label: t.name }))
      : detail.members.map((m) => ({ id: m.id, label: m.handle }));
  const pick = (next: BudgetScopeKind): void =>
    onTarget({
      kind: next,
      id: (next === "team" ? detail.teams[0]?.id : detail.members[0]?.id) ?? "",
    });
  return (
    <>
      <label>
        Budget scope
        <select value={kind} onChange={(e) => pick(e.currentTarget.value as BudgetScopeKind)}>
          <option value="org">Whole org</option>
          <option value="team">Team</option>
          <option value="member">Member</option>
        </select>
      </label>
      {kind !== "org" && (
        <label>
          Budget target
          <select value={id} onChange={(e) => onTarget({ kind, id: e.currentTarget.value })}>
            {options.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}

function BudgetForm({
  detail,
  initial,
  onDone,
}: {
  detail: OrgDetail;
  initial: { kind: BudgetScopeKind; id: string; usd: string };
  onDone: () => void;
}): preact.JSX.Element {
  const [target, setTarget] = useState<Target>({ kind: initial.kind, id: initial.id });
  const [usd, setUsd] = useState(initial.usd);
  const action = useAction();
  const save = (): void => {
    const scopeId = target.kind === "org" ? detail.org.id : target.id;
    const body = { scopeKind: target.kind, scopeId, monthlyUsd: Number(usd) };
    action
      .run(async () => {
        await api(`/api/orgs/${detail.org.slug}/budgets`, ignored, { method: "PUT", body });
        onDone();
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <form
      class="row"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <TargetFields detail={detail} target={target} onTarget={setTarget} />
      <label>
        Monthly limit (USD)
        <input
          type="number"
          min="0.01"
          step="0.01"
          required
          value={usd}
          onInput={(e) => setUsd(e.currentTarget.value)}
        />
      </label>
      <button type="submit" disabled={action.busy}>
        Save budget
      </button>
      <ErrorLine message={action.error} />
    </form>
  );
}

function Meter({ budget }: { budget: BudgetView }): preact.JSX.Element {
  const pct = Math.min(100, Math.round(budget.ratio * 100));
  return (
    <span class="bar" aria-hidden="true">
      <span class={`bar-fill ${budget.state}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

function BudgetItem({
  budget,
  detail,
  onEdit,
  onChanged,
}: {
  budget: BudgetView;
  detail: OrgDetail;
  onEdit: () => void;
  onChanged: () => void;
}): preact.JSX.Element {
  const action = useAction();
  const remove = (): void => {
    action
      .run(async () => {
        await api(`/api/orgs/${detail.org.slug}/budgets/${budget.id}`, ignored, {
          method: "DELETE",
        });
        onChanged();
      })
      .catch((err: unknown) => console.error(err));
  };
  const name = scopeName(budget, detail);
  return (
    <li class="card">
      <strong>{name}</strong>: ${budget.spentUsd.toFixed(2)} of ${budget.monthlyUsd.toFixed(2)} (
      {Math.round(budget.ratio * 100)}%), status{" "}
      <span class={`budget-state ${budget.state}`}>{STATE_TEXT[budget.state]}</span>
      {budget.unpriced > 0 && <small class="muted"> + {budget.unpriced} unpriced</small>}
      <Meter budget={budget} />
      <div class="row">
        <button type="button" aria-label={`Edit budget for ${name}`} onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          class="danger"
          aria-label={`Delete budget for ${name}`}
          disabled={action.busy}
          onClick={remove}
        >
          Delete
        </button>
      </div>
      <ErrorLine message={action.error} />
    </li>
  );
}

export function Budgets({ detail }: { detail: OrgDetail }): preact.JSX.Element {
  const list = useLoad(
    () => api(`/api/orgs/${detail.org.slug}/budgets`, budgetListSchema),
    [detail.org.slug],
  );
  // Remounting the form on edit is the simplest way to reload its fields from the chosen budget.
  const [form, setForm] = useState<{ n: number; kind: BudgetScopeKind; id: string; usd: string }>({
    n: 0,
    kind: "org",
    id: "",
    usd: "",
  });
  const edit = (b: BudgetView): void =>
    setForm((f) => ({ n: f.n + 1, kind: b.scopeKind, id: b.scopeId, usd: String(b.monthlyUsd) }));
  return (
    <section>
      <h3>Budgets</h3>
      <ErrorLine message={list.error} />
      {list.data?.length === 0 && <p class="muted">No budgets set.</p>}
      <ul class="plain">
        {list.data?.map((b) => (
          <BudgetItem
            key={b.id}
            budget={b}
            detail={detail}
            onEdit={() => edit(b)}
            onChanged={list.reload}
          />
        ))}
      </ul>
      <BudgetForm key={form.n} detail={detail} initial={form} onDone={list.reload} />
    </section>
  );
}
