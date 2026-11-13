import type { OrgDetail } from "@shared/orgs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ignored } from "../../auth/me";
import { filedStamp } from "../../format";
import { createAction } from "../../ui/action";
import { Button, Help, StatusBadge, statusWord } from "../../ui/atoms";
import { ConfirmButton, Field } from "../../ui/molecules";
import { handleOf, policyMeta, valueWord } from "./policies-data";
import type { Proposal } from "./proposal-schema";

function Decide(props: {
  proposal: Proposal;
  slug: string;
  target: string;
  onDone: () => void;
}): JSX.Element {
  const [reason, setReason] = createSignal("");
  const action = createAction();
  const name = policyMeta[props.proposal.key].name;
  const decide = (decision: "approve" | "reject"): Promise<void> =>
    action.run(async () => {
      const path = `/api/orgs/${props.slug}/policy-proposals/${props.proposal.id}/decide`;
      await api(path, ignored, { method: "POST", body: { decision, reason: reason() } });
      props.onDone();
    });
  return (
    <div class="stack">
      <Field label={`Reason for the ${name} decision (optional)`} error={action.error()}>
        {(c) => (
          <input {...c()} value={reason()} onInput={(e) => setReason(e.currentTarget.value)} />
        )}
      </Field>
      <div class="row-actions">
        <Button
          tone="primary"
          aria-label={`Approve proposal for ${name}`}
          disabled={action.busy()}
          onClick={() => void decide("approve")}
        >
          Approve proposal
        </Button>
        <ConfirmButton
          tone="secondary"
          text="Reject proposal"
          label={`Reject proposal for ${name}`}
          disabled={action.busy()}
          title={`Reject the proposal for ${name}?`}
          message="The proposed value is not applied. The proposer sees your reason."
          confirm="Reject proposal"
          onConfirm={() => void decide("reject")}
        />
      </div>
      <Help>
        Approve sets {valueWord(props.proposal.key, props.proposal.value)} for {props.target} only.
        Reject changes nothing.
      </Help>
    </div>
  );
}

export function ProposalCard(props: {
  proposal: Proposal;
  detail: OrgDetail;
  onDone: () => void;
}): JSX.Element {
  const p = (): Proposal => props.proposal;
  const who = (id: string): string => `@${handleOf(id, props.detail.members)}`;
  // A person decides by user id and an agent by member id.
  const decider = (id: string): string => {
    const person = props.detail.members.find((m) => m.userId === id);
    return person ? `@${person.handle}` : who(id);
  };
  const status = (): ReturnType<typeof statusWord> => statusWord(p().status);
  return (
    <li class={p().status === "open" ? "policy-card proposal-open" : "policy-card"}>
      <p class="proposal-line">
        <strong>{who(p().proposedBy)}</strong> {p().status === "open" ? "proposes" : "proposed"}{" "}
        <strong>{policyMeta[p().key].name}</strong> <code>{p().key}</code> ={" "}
        <strong>{valueWord(p().key, p().value)}</strong> for {who(p().targetId)}
        <StatusBadge
          tone={p().status === "open" ? "warning" : status().tone}
          value={status().word}
        />
      </p>
      <p class="muted-line">
        {filedStamp(p().decidedAt ?? p().createdAt)}
        {p().status === "open" ? `: ${p().reason || "no reason given"}` : "."}
        <Show when={p().decidedBy}>
          {(by) =>
            ` Decided by ${decider(by())}${p().decisionReason ? `: ${p().decisionReason}` : "."}`
          }
        </Show>
      </p>
      <Show when={p().reviews.length > 0}>
        <ul class="review-list">
          <For each={p().reviews}>
            {(r) => (
              <li>
                {who(r.reviewerId)} reviewed: {r.verdict}
                {r.comment ? `, "${r.comment}"` : ""}
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={p().status === "open"}>
        <Decide
          proposal={p()}
          slug={props.detail.org.slug}
          target={who(p().targetId)}
          onDone={props.onDone}
        />
      </Show>
    </li>
  );
}
