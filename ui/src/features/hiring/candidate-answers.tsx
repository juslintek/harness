import type { HireView } from "@shared/hiring";
import { For, type JSX, Show } from "solid-js";
import type { Candidate } from "./score-table";

export function CandidateAnswers(props: {
  hire: HireView;
  candidate: Candidate;
  handleOf: (memberId: string) => string;
}): JSX.Element {
  const asked = (): HireView["questions"] =>
    props.hire.questions.filter(
      (q) => q.candidateId === null || q.candidateId === props.candidate.id,
    );
  const answerOf = (id: string): string | undefined =>
    props.candidate.answers.find((a) => a.questionId === id)?.body;
  const text = (q: HireView["questions"][number]): string =>
    q.kind === "followup" && q.askedBy
      ? `Follow-up from @${props.handleOf(q.askedBy)}: ${q.body}`
      : q.body;
  return (
    <Show when={asked().length > 0} fallback={<p class="muted">No questions asked yet.</p>}>
      <dl class="answers">
        <For each={asked()}>
          {(q) => (
            <div>
              <dt>{text(q)}</dt>
              <dd>{answerOf(q.id) ?? <span class="muted">no answer yet</span>}</dd>
            </div>
          )}
        </For>
      </dl>
    </Show>
  );
}
