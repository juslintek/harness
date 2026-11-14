import { type JSX, Show } from "solid-js";
import type { Candidate } from "./score-table";

export function SelfCard(props: { candidate: Candidate }): JSX.Element {
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
            <dd>{card().limits.join(", ") || "none"}</dd>
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
