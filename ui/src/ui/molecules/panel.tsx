import { createUniqueId, type JSX, type ParentProps, Show } from "solid-js";
import "./panel.css";

export function Panel(props: ParentProps<{ title: string; actions?: JSX.Element }>): JSX.Element {
  const id = createUniqueId();
  return (
    <section class="panel" aria-labelledby={id}>
      <header class="panel-head">
        <h2 id={id} class="panel-title">
          {props.title}
        </h2>
        <Show when={props.actions}>
          <div class="panel-actions">{props.actions}</div>
        </Show>
      </header>
      <div class="panel-body">{props.children}</div>
    </section>
  );
}
