import type { HireView } from "@shared/hiring";
import { type JSX, Show } from "solid-js";
import { filedStamp } from "../../format";
import { Help, StatusBadge, statusWord } from "../../ui/atoms";
import { Steps } from "../../ui/molecules";
import { isOpen, stepsOf, whoActs } from "./hire-phase";
import { UpdatedAgo } from "./updated-ago";

const STEP_WORD: Partial<Record<HireView["status"], string>> = {
  interviewing: "interviewing",
  followups: "follow-ups",
  answering: "follow-ups",
  scoring: "scoring",
  deciding: "decision",
};

export function HireHeader(props: {
  view: HireView;
  slug: string;
  onRefresh: () => void;
}): JSX.Element {
  const spec = (): HireView["spec"] => props.view.spec;
  const status = (): ReturnType<typeof statusWord> => statusWord(props.view.status, "hire");
  return (
    <div class="hire-head">
      <a class="hire-link" href={`#/o/${props.slug}/hiring`}>
        Back to requests
      </a>
      <h2 class="hiring-title">
        {spec().title} <StatusBadge tone={status().tone} value={status().word} />
      </h2>
      <p>{spec().summary}</p>
      <p class="muted">
        Specialty: {spec().specialty}. Task types: {spec().taskTypes.join(", ")}.
      </p>
      <Show when={spec().mustHave.length > 0}>
        <p class="muted">Must-haves: {spec().mustHave.join("; ")}</p>
      </Show>
      <Show when={stepsOf(props.view.status)}>
        {(items) => <Steps items={items()} label="Hiring steps" />}
      </Show>
      <Show
        when={isOpen(props.view.status)}
        fallback={<Help>Closed {filedStamp(props.view.phaseStartedAt)}.</Help>}
      >
        <Help>
          <strong>Now, {STEP_WORD[props.view.status]}.</strong> {whoActs(props.view.status)}
        </Help>
      </Show>
      <UpdatedAgo stamp={() => props.view} onRefresh={props.onRefresh} />
    </div>
  );
}
