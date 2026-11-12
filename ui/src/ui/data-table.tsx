import type { JSX, ParentProps } from "solid-js";
import "./data-table.css";

// tabindex makes the scrolling box reachable by keyboard when the table is wider than the screen.
export function TableBox(props: ParentProps<{ label: string }>): JSX.Element {
  return (
    <section class="table-box" aria-label={props.label} tabindex="0">
      <table class="data-table">{props.children}</table>
    </section>
  );
}
