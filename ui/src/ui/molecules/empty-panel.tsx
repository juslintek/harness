import { type JSX, type ParentProps, Show } from "solid-js";
import { State } from "./state";
import "./empty-panel.css";

// An empty list: what it is, why it is empty, and the first actions as buttons (the children).
export function EmptyPanel(props: ParentProps<{ title: string; message: string }>): JSX.Element {
  return (
    <div class="empty-panel">
      <State kind="empty" title={props.title} message={props.message} />
      <Show when={props.children}>
        <div class="empty-panel-actions">{props.children}</div>
      </Show>
    </div>
  );
}
