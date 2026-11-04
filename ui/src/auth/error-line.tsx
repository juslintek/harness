import { type JSX, Show } from "solid-js";

export function ErrorLine(props: { message: string | null }): JSX.Element {
  return (
    <Show when={props.message}>
      {(message) => (
        <p class="error" role="alert">
          {message()}
        </p>
      )}
    </Show>
  );
}
