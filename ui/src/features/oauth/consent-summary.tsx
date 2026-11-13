import type { JSX } from "solid-js";

export function ConsentSummary(props: { app: string; email: string; host: string }): JSX.Element {
  return (
    <dl class="consent-summary">
      <dt>App asking</dt>
      <dd class="consent-app">{props.app}</dd>
      <dt>Signed in as</dt>
      <dd>{props.email}</dd>
      <dt>Sends you back to</dt>
      <dd>
        <code>{props.host}</code>
      </dd>
    </dl>
  );
}
