import { type OrgDetail, orgDetailSchema } from "@shared/orgs";
import { effectiveListSchema } from "@shared/policies";
import { createSignal, For, type JSX, Show } from "solid-js";
import { me } from "../../auth/me";
import { createLoad } from "../../load";
import { Panel, State } from "../../ui/primitives";
import { FormError, isAdmin } from "../orgs/shared";
import { Budgets } from "./budgets";
import { PolicyRow } from "./policy-row";
import { Proposals } from "./proposals";
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

function Policies(props: { detail: OrgDetail }): JSX.Element {
  // Same layer and target means the same list, so a new object alone must not refetch it.
  const [scope, setScope] = createSignal<Scope | null>(null, {
    equals: (a, b) => a?.layer === b?.layer && a?.targetId === b?.targetId,
  });
  return (
    <div class="policies">
      <p class="policies-intro">
        Each value comes from the strictest layer that sets it. Autonomy can only get stricter going
        down the layers.
      </p>
      <Panel title="Policies">
        <div class="stack">
          <ScopePicker detail={props.detail} onScope={setScope} />
          <Show when={scope()} keyed>
            {(s) => <Effective detail={props.detail} scope={s} />}
          </Show>
        </div>
      </Panel>
      <Proposals detail={props.detail} />
      <Budgets detail={props.detail} />
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
