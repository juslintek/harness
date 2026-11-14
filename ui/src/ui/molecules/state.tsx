import { type JSX, Show } from "solid-js";
import { Button } from "../atoms";
import "./state.css";

const ROLES = { loading: "status", empty: undefined, error: "alert" } as const;

export function State(props: {
  kind: "loading" | "empty" | "error";
  title?: string;
  message?: string;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div class="state" data-kind={props.kind} role={ROLES[props.kind]}>
      <Show when={props.title}>
        <p class="state-title">{props.title}</p>
      </Show>
      <p>{props.message ?? (props.kind === "loading" ? "Loading…" : "")}</p>
      <Show when={props.kind === "error" && props.onRetry}>
        {(retry) => <Button onClick={() => retry()()}>Retry</Button>}
      </Show>
    </div>
  );
}
