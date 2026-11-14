import type { JSX, ParentProps } from "solid-js";
import "./data-table.css";

// tabindex makes the scrolling box reachable by keyboard when the table is wider than the screen.
// `stack` turns each row into a block of "label value" lines on a phone, from the cells'
// data-label, instead of scrolling sideways.
export function TableBox(props: ParentProps<{ label: string; stack?: boolean }>): JSX.Element {
  return (
    <section
      class="table-box"
      aria-label={props.label}
      tabindex="0"
      data-stack={props.stack ? "" : undefined}
    >
      <table class="data-table">{props.children}</table>
    </section>
  );
}
