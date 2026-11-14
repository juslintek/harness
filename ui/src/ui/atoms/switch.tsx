import type { JSX } from "solid-js";
import "./switch.css";

export function Switch(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  ariaLabel?: string;
  tone?: "danger";
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      class="switch"
      aria-checked={props.checked}
      aria-label={props.label ? undefined : props.ariaLabel}
      data-tone={props.tone}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="switch-track" aria-hidden="true" />
      {props.label}
    </button>
  );
}
