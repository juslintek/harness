import { type JSX, Show } from "solid-js";
import { Notice } from "../../ui/molecules";

export function MemoryError(props: { message: string | null }): JSX.Element {
  return (
    <Show when={props.message}>{(message) => <Notice tone="danger">{message()}</Notice>}</Show>
  );
}
