import type { HireView } from "@shared/hiring";
import { createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ignored } from "../../auth/me";
import { createAction } from "../../ui/action";
import { Button, Field, Panel, StatusBadge } from "../../ui/primitives";
import { FormError } from "../orgs/shared";
import { CANDIDATE_TONE } from "./hire-phase";

export type Candidate = HireView["candidates"][number];

const CRITERIA = ["fit", "depth", "honesty"] as const;
const SCALE = [1, 2, 3, 4, 5];

function ScoreForm(props: {
  base: string;
  candidate: Candidate;
  onSaved: () => void;
}): JSX.Element {
  const [marks, setMarks] = createSignal({ fit: 3, depth: 3, honesty: 3 });
  const [notes, setNotes] = createSignal("");
  const action = createAction();
  const submit = (e: Event): void => {
    e.preventDefault();
    void action.run(async () => {
      await api(`${props.base}/score/${props.candidate.id}`, ignored, {
        method: "POST",
        body: { ...marks(), notes: notes() },
      });
      setNotes("");
      props.onSaved();
    });
  };
  return (
    <form class="stack score-form" onSubmit={submit}>
      <div class="form-row">
        <For each={CRITERIA}>
          {(name) => (
            <Field label={`${name} (1 to 5)`}>
              {(c) => (
                <select
                  {...c()}
                  onChange={(e) => setMarks({ ...marks(), [name]: Number(e.currentTarget.value) })}
                >
                  <For each={SCALE}>
                    {(n) => (
                      <option value={n} selected={n === marks()[name]}>
                        {n}
                      </option>
                    )}
                  </For>
                </select>
              )}
            </Field>
          )}
        </For>
      </div>
      <Field label="Notes">
        {(c) => (
          <textarea
            {...c()}
            value={notes()}
            maxLength={1000}
            rows={2}
            onInput={(e) => setNotes(e.currentTarget.value)}
          />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={action.busy()}>
          Save scorecard
        </Button>
      </div>
      <FormError message={action.error()} />
    </form>
  );
}

function Answers(props: { hire: HireView; candidate: Candidate }): JSX.Element {
  const asked = (): HireView["questions"] =>
    props.hire.questions.filter(
      (q) => q.candidateId === null || q.candidateId === props.candidate.id,
    );
  const answerOf = (id: string): string | undefined =>
    props.candidate.answers.find((a) => a.questionId === id)?.body;
  return (
    <Show when={asked().length > 0} fallback={<p class="muted">No questions asked yet.</p>}>
      <dl class="answers">
        <For each={asked()}>
          {(q) => (
            <div>
              <dt>{q.body}</dt>
              <dd>{answerOf(q.id) ?? <span class="muted">no answer yet</span>}</dd>
            </div>
          )}
        </For>
      </dl>
    </Show>
  );
}

function SelfCard(props: { candidate: Candidate }): JSX.Element {
  return (
    <Show
      when={props.candidate.profile.card}
      fallback={<p class="muted">No self card submitted.</p>}
    >
      {(card) => (
        <dl class="answers">
          <div>
            <dt>Summary</dt>
            <dd>{card().summary}</dd>
          </div>
          <div>
            <dt>Specialties</dt>
            <dd>{card().specialties.join(", ") || "none"}</dd>
          </div>
          <div>
            <dt>Strengths</dt>
            <dd>{card().strengths.join(", ") || "none"}</dd>
          </div>
          <div>
            <dt>Limits</dt>
            <dd>{card().limits.join(", ")}</dd>
          </div>
          <div>
            <dt>Preferred task types</dt>
            <dd>{card().preferredTaskTypes.join(", ")}</dd>
          </div>
        </dl>
      )}
    </Show>
  );
}

export const engineName = (c: Candidate): string =>
  `${c.profile.runtime}${c.profile.model ? ` / ${c.profile.model}` : ""}`;

export function CandidateCard(props: {
  hire: HireView;
  candidate: Candidate;
  base: string;
  canScore: boolean;
  handleOf: (memberId: string) => string;
  onChange: () => void;
}): JSX.Element {
  const c = (): Candidate => props.candidate;
  return (
    <Panel
      title={engineName(c())}
      actions={<StatusBadge tone={CANDIDATE_TONE[c().status]} value={c().status} />}
    >
      <div class="stack">
        <p>
          System score: {c().systemScore?.toFixed(1) ?? "not scored"}. Total:{" "}
          {c().total?.toFixed(1) ?? "not yet"}.
        </p>
        <div class="cols">
          <div class="stack">
            <h3 class="sub-title">Answers</h3>
            <Answers hire={props.hire} candidate={c()} />
          </div>
          <div class="stack">
            <h3 class="sub-title">Self card</h3>
            <SelfCard candidate={c()} />
          </div>
        </div>
        <h3 class="sub-title">Scorecards</h3>
        <Show when={c().scorecards.length > 0} fallback={<p class="muted">No scorecards yet.</p>}>
          <ul class="plain">
            <For each={c().scorecards}>
              {(s) => (
                <li>
                  @{props.handleOf(s.scorerId)}: fit {s.fit}, depth {s.depth}, honesty {s.honesty}
                  <Show when={s.notes}>
                    <span class="muted"> ({s.notes})</span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={props.canScore}>
          <ScoreForm base={props.base} candidate={c()} onSaved={props.onChange} />
        </Show>
      </div>
    </Panel>
  );
}
