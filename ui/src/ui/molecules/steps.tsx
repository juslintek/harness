import { For, type JSX } from "solid-js";
import "./steps.css";

export interface Step {
  label: string;
  state: "done" | "current" | "todo";
}

export function Steps(props: { items: Step[]; label: string }): JSX.Element {
  return (
    <ol class="steps" aria-label={props.label}>
      <For each={props.items}>
        {(step, i) => (
          <li
            class="step"
            data-state={step.state}
            aria-current={step.state === "current" ? "step" : undefined}
          >
            <span class="step-mark" aria-hidden="true">
              {step.state === "done" ? "✓" : i() + 1}
            </span>
            <span class="step-label">{step.label}</span>
            {step.state === "done" && <span class="sr-only"> (done)</span>}
          </li>
        )}
      </For>
    </ol>
  );
}
