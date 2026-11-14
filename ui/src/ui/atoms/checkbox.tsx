import type { JSX } from "solid-js";
import "./checkbox.css";

// A real input stays in the page for keyboard and screen readers; the box next to it is only paint.
export function Checkbox(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: JSX.Element;
  disabled?: boolean;
}): JSX.Element {
  return (
    <label class="checkbox">
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      <span class="checkbox-box" aria-hidden="true">
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <polyline points="2.5 6.5 5 9 9.5 3.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
      <span class="checkbox-label">{props.label}</span>
    </label>
  );
}
