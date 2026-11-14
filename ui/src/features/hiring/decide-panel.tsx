import { budgetListSchema } from "@shared/budgets";
import type { HireView } from "@shared/hiring";
import type { OrgDetail } from "@shared/orgs";
import { effectiveListSchema } from "@shared/policies";
import { createSignal, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ignored } from "../../auth/me";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { Button, Help } from "../../ui/atoms";
import { ConfirmButton, Field, Notice, Panel } from "../../ui/molecules";
import { FormError } from "../orgs/shared";
import { valueWord } from "../policies/policies-data";
import { HireTerms } from "./hire-terms";
import { engineName, ScoreTable } from "./score-table";

const WHO_WAS_ASKED = {
  auto: "so the best total is hired when it reaches the minimum score",
  manager: "so the team manager agent was asked too",
  human: "so only admins are asked",
} as const;

export function DecidePanel(props: {
  detail: OrgDetail;
  hire: HireView;
  base: string;
  onDecided: () => void;
}): JSX.Element {
  const slug = props.detail.org.slug;
  const policies = createLoad(
    `/api/orgs/${slug}/policies?team=${props.hire.teamId}`,
    effectiveListSchema,
  );
  const budgets = createLoad(`/api/orgs/${slug}/budgets`, budgetListSchema);
  const [reason, setReason] = createSignal("");
  const action = createAction();
  const team = (): string =>
    props.detail.teams.find((t) => t.id === props.hire.teamId)?.name ?? props.hire.teamId;
  const policy = (): { word: string; who: string } | undefined => {
    const item = policies.data()?.find((p) => p.key === "hiring.decision");
    if (!item) return undefined;
    return {
      word: valueWord("hiring.decision", item.value),
      who: WHO_WAS_ASKED[item.value as keyof typeof WHO_WAS_ASKED] ?? "",
    };
  };
  const decide = (candidateId: string | null): void => {
    void action.run(async () => {
      await api(`${props.base}/decide`, ignored, {
        method: "POST",
        body: { candidateId, reason: reason() },
      });
      props.onDecided();
    });
  };
  return (
    <>
      <Notice tone="warning" standing title="Needs your decision">
        {`Scoring is done.${policy() ? ` The policy Who decides hires is ${policy()?.word} for team ${team()}, ${policy()?.who}.` : ""} The first decision counts.`}
      </Notice>
      <Panel title="Your decision">
        <div class="stack">
          <Show when={policies.data() && budgets.data()}>
            <HireTerms
              detail={props.detail}
              hire={props.hire}
              policies={policies.data() ?? []}
              budgets={budgets.data() ?? []}
            />
          </Show>
          <FormError message={policies.error() ?? budgets.error()} />
          <Field label="Reason (optional, shown on the request)">
            {(c) => (
              <textarea
                {...c()}
                value={reason()}
                maxLength={500}
                rows={2}
                onInput={(e) => setReason(e.currentTarget.value)}
              />
            )}
          </Field>
          <h3 class="sub-title">Choose one</h3>
          <ScoreTable
            hire={props.hire}
            label="Candidates to choose from"
            action={(c) => (
              <Button disabled={action.busy()} onClick={() => decide(c.id)}>
                {`Hire ${engineName(c)}`}
              </Button>
            )}
          />
          <div class="form-row form-submit">
            <ConfirmButton
              text="Reject all candidates"
              disabled={action.busy()}
              title={`Reject all candidates for ${props.hire.spec.title}?`}
              message="The request closes as rejected and nobody is hired."
              confirm="Reject all candidates"
              onConfirm={() => decide(null)}
            />
            <Help>
              Deciding asks for your passkey. Rejecting closes the request and nobody is hired.
            </Help>
          </div>
          <FormError message={action.error()} />
        </div>
      </Panel>
    </>
  );
}
