import { type BudgetView, budgetListSchema } from "@shared/budgets";
import { type OrgDetail, orgDetailSchema } from "@shared/orgs";
import { effectiveListSchema } from "@shared/policies";
import { createSignal, For, type JSX, Show } from "solid-js";
import { me } from "../../auth/me";
import { createLoad } from "../../load";
import { Button, Help } from "../../ui/atoms";
import { Notice, Panel, State } from "../../ui/molecules";
import { FormError, isAdmin } from "../orgs/shared";
import type { BudgetInitial } from "./budget-form";
import { scopeName } from "./budget-row";
import { Budgets } from "./budgets";
import { handleOf, policyMeta, valueWord } from "./policies-data";
import { PolicyRow } from "./policy-row";
import { type Proposal, proposalsSchema } from "./proposal-schema";
import { OpenProposals, PastProposals } from "./proposals";
import { type Scope, ScopePicker } from "./scope-picker";
import "../orgs/settings.css";
import "./policies.css";

function Effective(props: { detail: OrgDetail; scope: Scope }): JSX.Element {
  const slug = (): string => props.detail.org.slug;
  const list = createLoad(
    () => `/api/orgs/${slug()}/policies${props.scope.query}`,
    effectiveListSchema,
    [`org:${props.detail.org.id}`],
  );
  return (
    <>
      <FormError message={list.error()} />
      <ul class="card-list">
        <For each={list.data()}>
          {(item) => (
            <PolicyRow
              item={item}
              scope={props.scope}
              slug={slug()}
              onChanged={() => void list.reload()}
            />
          )}
        </For>
      </ul>
    </>
  );
}

const money = (usd: number): string => `$${usd.toFixed(2)}`;

// A paused budget starts again at the start of the next UTC month.
function pausedText(list: BudgetView[], detail: OrgDetail): string {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const until = next.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const tail = `stopped and new wake-ups are skipped until ${until} (UTC) or until you raise the limit.`;
  const first = list[0] as BudgetView;
  if (list.length > 1) return `Their runs are ${tail}`;
  const name = scopeName(first, detail);
  const who = first.scopeKind === "member" ? `@${name.slice("Member ".length)}` : name;
  return `${who} reached ${money(first.spentUsd)} of ${money(first.monthlyUsd)}. Its runs are ${tail}`;
}

function proposalText(list: Proposal[], detail: OrgDetail): string {
  const first = list[0] as Proposal;
  const at = (id: string): string => `@${handleOf(id, detail.members)}`;
  const line = `${at(first.proposedBy)} proposes ${policyMeta[first.key].name} = ${valueWord(first.key, first.value)} for ${at(first.targetId)}.`;
  return list.length > 1 ? `${line} ${list.length - 1} more below.` : line;
}

function Policies(props: { detail: OrgDetail }): JSX.Element {
  const slug = props.detail.org.slug;
  const budgets = createLoad(`/api/orgs/${slug}/budgets`, budgetListSchema);
  const open = createLoad(`/api/orgs/${slug}/policy-proposals?status=open`, proposalsSchema);
  const all = createLoad(`/api/orgs/${slug}/policy-proposals`, proposalsSchema);
  const past = (): Proposal[] => (all.data() ?? []).filter((p) => p.status !== "open");
  const reloadProposals = (): void => {
    void open.reload();
    void all.reload();
  };
  // A new object per edit remounts the form, which loads its fields from the chosen budget.
  const [form, setForm] = createSignal<BudgetInitial>({ kind: "org", id: "", usd: "" });
  const paused = (): BudgetView[] => (budgets.data() ?? []).filter((b) => b.state === "paused");
  const raise = (b: BudgetView): void => {
    setForm({ kind: b.scopeKind, id: b.scopeId, usd: String(b.monthlyUsd) });
    requestAnimationFrame(() => {
      const budgetForm = document.getElementById("budget-form");
      budgetForm?.scrollIntoView();
      budgetForm?.querySelector<HTMLInputElement>('input[type="number"]')?.focus();
    });
  };
  const review = (): void => {
    const box = document.getElementById("open-proposals");
    box?.scrollIntoView();
    box?.focus();
  };
  // Same layer and target means the same list, so a new object alone must not refetch it.
  const [scope, setScope] = createSignal<Scope | null>(null, {
    equals: (a, b) => a?.layer === b?.layer && a?.targetId === b?.targetId,
  });
  const failed = (): string | null => budgets.error() ?? open.error() ?? all.error();
  return (
    <div class="policies">
      <Help>
        Rules for what agents may do and spend. Admins and owners can change them; other roles
        cannot open this page. Changes ask for your passkey.
      </Help>
      <FormError message={failed()} />
      <Show when={paused().length > 0}>
        <Notice
          tone="warning"
          title={`${paused().length} ${paused().length === 1 ? "budget is" : "budgets are"} paused`}
          actions={
            <Button size="sm" onClick={() => raise(paused()[0] as BudgetView)}>
              Raise limit
            </Button>
          }
        >
          {pausedText(paused(), props.detail)}
        </Notice>
      </Show>
      <Show when={(open.data()?.length ?? 0) > 0}>
        <Notice
          tone="warning"
          title={`${open.data()?.length} ${open.data()?.length === 1 ? "policy change waits" : "policy changes wait"} for you`}
          actions={
            <Button size="sm" onClick={review}>
              Review proposal
            </Button>
          }
        >
          {proposalText(open.data() ?? [], props.detail)}
        </Notice>
      </Show>
      <div class="policies-top">
        <Show when={budgets.data()} fallback={<State kind="loading" />}>
          {(list) => (
            <Budgets
              detail={props.detail}
              list={list()}
              form={form}
              onEdit={raise}
              onChanged={() => void budgets.reload()}
            />
          )}
        </Show>
        <div class="policies-side">
          <OpenProposals detail={props.detail} list={open.data() ?? []} onDone={reloadProposals} />
          <PastProposals detail={props.detail} list={past()} />
        </div>
      </div>
      <Panel title="Rules">
        <div class="stack">
          <ScopePicker detail={props.detail} onScope={setScope} />
          <Show when={scope()} keyed>
            {(s) => <Effective detail={props.detail} scope={s} />}
          </Show>
          <Help>
            Command rules (what is allowed, asked or denied) are built into the server and are not
            edited here. Autonomy can add questions, never remove a block.
          </Help>
        </div>
      </Panel>
    </div>
  );
}

export function PoliciesPage(props: { slug: string }): JSX.Element {
  const known = (): boolean => me()?.orgs.some((o) => o.slug === props.slug) ?? false;
  return (
    <Show when={known()} fallback={<State kind="empty" message="Org not found" />}>
      <PoliciesBody slug={props.slug} />
    </Show>
  );
}

function PoliciesBody(props: { slug: string }): JSX.Element {
  const org = createLoad(() => `/api/orgs/${props.slug}`, orgDetailSchema);
  return (
    <Show
      when={org.data()}
      fallback={
        <State
          kind={org.error() ? "error" : "loading"}
          {...(org.error()
            ? { message: org.error() as string, onRetry: () => void org.reload() }
            : {})}
        />
      }
    >
      {(detail) => (
        <Show
          when={isAdmin(detail())}
          fallback={<State kind="empty" message="Policies are visible to org admins." />}
        >
          <Policies detail={detail()} />
        </Show>
      )}
    </Show>
  );
}
