import type { JSX } from "solid-js";
import type { Tone } from "./status-badge";
import "./dot.css";

export function Dot(props: { tone: Tone }): JSX.Element {
  return <span class="dot" data-tone={props.tone} aria-hidden="true" />;
}
