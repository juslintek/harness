import type { HireView } from "@shared/hiring";
import { For, type JSX, Show } from "solid-js";
import { StatusBadge } from "../../ui/atoms";
import { Panel } from "../../ui/molecules";
import { CandidateAnswers } from "./candidate-answers";
import { ScoreForm } from "./score-form";
import { type Candidate, engineName } from "./score-table";
import { SelfCard } from "./self-card";

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
    <Panel title={engineName(c())} actions={<StatusBadge kind="candidate" value={c().status} />}>
      <div class="stack">
        <p>
          System score{" "}
          {c().systemScore === null ? "not scored" : `${c().systemScore?.toFixed(1)} of 5`}. Total{" "}
          {c().total?.toFixed(1) ?? "not yet"}.
        </p>
        <div class="cols">
          <div class="stack">
            <h3 class="sub-title">Answers</h3>
            <CandidateAnswers hire={props.hire} candidate={c()} handleOf={props.handleOf} />
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
