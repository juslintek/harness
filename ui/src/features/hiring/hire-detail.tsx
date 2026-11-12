import { type HireView, hireViewSchema } from "@shared/hiring";
import { orgDetailSchema } from "@shared/orgs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ignored } from "../../auth/me";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { Button, Field, Panel, State, StatusBadge } from "../../ui/primitives";
import { FormError, isAdmin } from "../orgs/shared";
import { CandidateCard, engineName } from "./candidate-card";
import { HIRE_TONE, hirePhase } from "./hire-phase";
import "../orgs/settings.css";
import "./hiring.css";

function Decide(props: { hire: HireView; base: string; onDecided: () => void }): JSX.Element {
  const [reason, setReason] = createSignal("");
  const [rejecting, setRejecting] = createSignal(false);
  const action = createAction();
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
    <Panel title="Decision">
      <div class="stack">
        <Field label="Reason (optional)">
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
        <p class="muted">Deciding asks for your passkey.</p>
        <div class="row-actions">
          <For each={props.hire.candidates}>
            {(c) => (
              <Button tone="primary" disabled={action.busy()} onClick={() => decide(c.id)}>
                Hire {engineName(c)}
              </Button>
            )}
          </For>
          <Button tone="danger" disabled={action.busy()} onClick={() => setRejecting(true)}>
            Reject all
          </Button>
        </div>
        <FormError message={action.error()} />
      </div>
      <ConfirmDialog
        open={rejecting()}
        title="Reject all candidates?"
        message="The request closes as rejected and nobody is hired."
        confirm="Reject all"
        onClose={() => setRejecting(false)}
        onConfirm={() => {
          setRejecting(false);
          decide(null);
        }}
      />
    </Panel>
  );
}

function Summary(props: { view: HireView; slug: string }): JSX.Element {
  const spec = (): HireView["spec"] => props.view.spec;
  return (
    <div class="hire-head">
      <a class="hire-link" href={`#/o/${props.slug}/hiring`}>
        Back to requests
      </a>
      <h2 class="hiring-title">
        {spec().title} <StatusBadge tone={HIRE_TONE[props.view.status]} value={props.view.status} />
      </h2>
      <p>{spec().summary}</p>
      <p class="muted">
        {spec().specialty}; task types: {spec().taskTypes.join(", ")}
        {spec().mustHave.length > 0 && `; must have: ${spec().mustHave.join(", ")}`}
      </p>
      <Show when={props.view.decisionReason}>
        <p>Decision: {props.view.decisionReason}</p>
      </Show>
    </div>
  );
}

export function HireDetail(props: { slug: string; id: string }): JSX.Element {
  const base = `/api/orgs/${props.slug}/hires/${props.id}`;
  const org = createLoad(`/api/orgs/${props.slug}`, orgDetailSchema);
  const hire = createLoad(base, hireViewSchema);
  const handleOf = (memberId: string): string =>
    org.data()?.members.find((m) => m.id === memberId)?.handle ?? memberId;
  const admin = (): boolean => {
    const detail = org.data();
    return detail ? isAdmin(detail) : false;
  };
  const error = (): string | null => hire.error() ?? org.error();
  return (
    <div class="hiring">
      <Show when={error()}>
        {(message) => (
          <p class="form-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show
        when={hire.data()}
        fallback={
          <>
            <a class="hire-link" href={`#/o/${props.slug}/hiring`}>
              Back to requests
            </a>
            <Show when={!error()}>
              <State kind="loading" />
            </Show>
          </>
        }
      >
        {(view) => (
          <>
            <Summary view={view()} slug={props.slug} />
            <div>
              <Button onClick={() => void hire.reload()}>Refresh</Button>
            </div>
            <h2 class="sub-title">Candidates</h2>
            <For each={view().candidates}>
              {(c) => (
                <CandidateCard
                  hire={view()}
                  candidate={c}
                  base={base}
                  canScore={admin() && hirePhase(view().status).scoring}
                  handleOf={handleOf}
                  onChange={() => void hire.reload()}
                />
              )}
            </For>
            <Show when={admin() && hirePhase(view().status).deciding}>
              <Decide hire={view()} base={base} onDecided={() => void hire.reload()} />
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
