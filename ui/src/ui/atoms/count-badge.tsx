import type { JSX } from "solid-js";
import "./count-badge.css";

export function CountBadge(props: { count: number; tone?: "neutral" | "warning" }): JSX.Element {
  return (
    <span class="count-badge" data-tone={props.tone ?? "neutral"}>
      {props.count}
    </span>
  );
}
