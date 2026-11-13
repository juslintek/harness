import type { OrgDetail } from "@shared/orgs";
import { For, type JSX, Show } from "solid-js";
import { Help } from "../../ui/atoms";
import { Panel } from "../../ui/molecules";
import { ProposalCard } from "./proposal-card";
import type { Proposal } from "./proposal-schema";

export function OpenProposals(props: {
  detail: OrgDetail;
  list: Proposal[];
  onDone: () => void;
}): JSX.Element {
  return (
    <section id="open-proposals" tabindex="-1" class="proposals-anchor">
      <Panel title="Open proposals">
        <div class="stack">
          <Help>
            An agent can propose a change to its own rules. Nothing changes until you approve it.
          </Help>
          <Show when={props.list.length === 0}>
            <p class="muted-line">
              No open proposals. When an agent proposes a change, it shows here with Approve and
              Reject.
            </p>
          </Show>
          <ul class="card-list">
            <For each={props.list}>
              {(p) => <ProposalCard proposal={p} detail={props.detail} onDone={props.onDone} />}
            </For>
          </ul>
        </div>
      </Panel>
    </section>
  );
}

export function PastProposals(props: { detail: OrgDetail; list: Proposal[] }): JSX.Element {
  return (
    <Panel title="Past proposals">
      <div class="stack">
        <Show when={props.list.length === 0}>
          <p class="muted-line">No proposals have been decided yet.</p>
        </Show>
        <ul class="card-list">
          <For each={props.list}>
            {(p) => <ProposalCard proposal={p} detail={props.detail} onDone={() => undefined} />}
          </For>
        </ul>
      </div>
    </Panel>
  );
}
