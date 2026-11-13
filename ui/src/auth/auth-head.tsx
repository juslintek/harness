import type { JSX } from "solid-js";
import "./auth.css";

export function AuthHead(props: { title: string; sub?: JSX.Element }): JSX.Element {
  return (
    <div class="auth-head">
      <span class="auth-brand">Harness</span>
      <h1>{props.title}</h1>
      {props.sub && <p class="auth-note">{props.sub}</p>}
    </div>
  );
}
