import type { JSX } from "solid-js";
import { type StatusKind, statusWord } from "./status";
import "./status-badge.css";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

// The word is plain English (see status.ts); the tone only adds colour to it. With `kind`, `value`
// is the raw status and both come from statusWord.
export function StatusBadge(
  props: { tone: Tone; value: string } | { kind: StatusKind; value: string },
): JSX.Element {
  const shown = (): { word: string; tone: Tone } =>
    "kind" in props ? statusWord(props.value, props.kind) : { word: props.value, tone: props.tone };
  return (
    <span class="badge" data-tone={shown().tone}>
      {shown().word}
    </span>
  );
}
