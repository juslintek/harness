import type { RunView } from "@shared/runs";
import type { JSX } from "solid-js";
import { ButtonLink, StatusBadge, statusWord } from "../../ui/atoms";

export function FollowRow(props: { run: RunView }): JSX.Element {
  const state = (): { word: string; tone: "info" | "neutral" } => ({
    word: statusWord(props.run.state).word,
    tone: props.run.state === "queued" ? "neutral" : "info",
  });
  return (
    <li class="logs-follow">
      <a class="mono" href={`#/runs/${props.run.id}`}>
        {props.run.id.slice(0, 8)}
      </a>
      <StatusBadge tone={state().tone} value={state().word} />
      <span class="logs-follow-prompt">{props.run.prompt}</span>
      <ButtonLink size="sm" href={`#/runs/${props.run.id}`}>
        Follow live
      </ButtonLink>
    </li>
  );
}
