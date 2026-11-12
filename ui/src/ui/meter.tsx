import type { JSX } from "solid-js";
import "./meter.css";
import type { Tone } from "./primitives";

// Only for a value that has a real limit; `pct` is clamped here so callers pass the raw share.
export function Meter(props: {
  tone: Tone;
  label: string;
  value: string;
  pct: number;
}): JSX.Element {
  const pct = (): number => Math.max(0, Math.min(100, props.pct));
  return (
    <div class="meter">
      <div class="meter-text">
        <span>{props.label}</span>
        <span class="meter-value">{props.value}</span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: <meter> cannot be styled to the design */}
      <div
        class="meter-track"
        role="meter"
        aria-label={props.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct())}
        aria-valuetext={props.value}
      >
        <div class="meter-fill" data-tone={props.tone} style={{ width: `${pct()}%` }} />
      </div>
    </div>
  );
}
