import { createUniqueId, type JSX, Show } from "solid-js";
import "./field.css";

export interface FieldControl {
  id: string;
  "aria-invalid"?: "true";
  "aria-describedby"?: string;
}

// The control is passed in so one Field serves input, select and textarea alike.
export function Field(props: {
  label: string;
  error?: string | null | undefined;
  children: (control: () => FieldControl) => JSX.Element;
}): JSX.Element {
  const id = createUniqueId();
  const control = (): FieldControl =>
    props.error ? { id, "aria-invalid": "true", "aria-describedby": `${id}-error` } : { id };
  return (
    <div class="field">
      <label for={id}>{props.label}</label>
      {props.children(control)}
      <Show when={props.error}>
        {(message) => (
          <span id={`${id}-error`} class="field-error">
            {message()}
          </span>
        )}
      </Show>
    </div>
  );
}
