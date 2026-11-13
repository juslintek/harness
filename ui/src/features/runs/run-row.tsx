import { type JSX, Show } from "solid-js";
import { StatusBadge } from "../../ui/atoms";
import "./run-row.css";

// Plain data only: the caller loads and formats. A part that is not given is not drawn.
export interface RunRowProps {
  id: string;
  title?: string;
  agent: string;
  model?: string | null;
  state: string;
  // The run has a pending approval; the word becomes "waiting for you" in warning tone.
  waiting?: boolean;
  expires?: string;
  reason?: string;
  why?: string;
  whyHref?: string;
  started?: string;
  duration?: string;
  cost?: string;
  tokens?: string;
  reviewHref?: string;
}

export function RunRowHead(): JSX.Element {
  return (
    <div class="run-row-head" aria-hidden="true">
      <span>State</span>
      <span>What</span>
      <span>Why it started</span>
      <span>Agent · model</span>
      <span>Cost</span>
      <span>Duration</span>
      <span>Started</span>
    </div>
  );
}

export function RunRow(props: RunRowProps): JSX.Element {
  const href = (): string => `#/runs/${props.id}`;
  return (
    <div class="run-row" data-waiting={props.waiting ? "" : undefined}>
      <span class="run-row-state">
        <Show when={props.waiting} fallback={<StatusBadge kind="run" value={props.state} />}>
          <StatusBadge tone="warning" value="waiting for you" />
        </Show>
        <Show when={props.expires}>{(text) => <span class="run-row-expires">{text()}</span>}</Show>
      </span>
      <span class="run-row-what">
        <Show when={props.title}>
          {(title) => (
            <a class="run-row-title" href={href()}>
              {title()}
            </a>
          )}
        </Show>
        <span class="run-row-sub">
          <a class="mono" href={href()}>
            {props.id}
          </a>
          <Show when={props.reason}>{(text) => <span> · {text()}</span>}</Show>
          <Show when={props.reviewHref}>
            {(link) => (
              <>
                {" · "}
                <a href={link()}>Review command</a>
              </>
            )}
          </Show>
        </span>
      </span>
      <span class="run-row-why">
        <Show when={props.why}>
          {(text) => (
            <Show when={props.whyHref} fallback={text()}>
              {(link) => <a href={link()}>{text()}</a>}
            </Show>
          )}
        </Show>
      </span>
      <span class="run-row-agent">
        <span>{props.agent}</span>
        <Show when={props.model}>
          {(model) => <span class="run-row-model mono">{model()}</span>}
        </Show>
      </span>
      <span class="run-row-cost mono">
        <Show when={props.cost}>{(text) => <span>{text()}</span>}</Show>
        <Show when={props.tokens}>{(text) => <span class="run-row-tokens">{text()}</span>}</Show>
      </span>
      <span class="run-row-duration mono">{props.duration}</span>
      <span class="run-row-started mono">{props.started}</span>
    </div>
  );
}
