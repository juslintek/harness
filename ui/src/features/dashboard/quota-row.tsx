import type { QuotaWindow } from "@shared/tracking";
import { type JSX, Show } from "solid-js";
import { Meter } from "../../ui/atoms";

export const QUOTA_WARN = 80;

// Today shows the clock time only, a later day shows the date too.
function resets(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${time}`;
}

export function QuotaRow(props: { quota: QuotaWindow }): JSX.Element {
  const used = (): number | null => props.quota.usedPercent;
  return (
    <li class="dashboard-item">
      <div class="dashboard-row">
        <span>{props.quota.provider}</span>
      </div>
      <Show when={props.quota.window !== "unknown"}>
        <span class="dashboard-note">{props.quota.window} window</span>
      </Show>
      <Show when={used() !== null} fallback={<span class="dashboard-note">No reading yet</span>}>
        <Meter
          tone={(used() ?? 0) >= QUOTA_WARN ? "warning" : "success"}
          label={`${Math.round(used() ?? 0)}% of the window used`}
          value={props.quota.resetsAt === null ? "" : `resets ${resets(props.quota.resetsAt)}`}
          pct={used() ?? 0}
        />
        <p class="dashboard-note">Source: {props.quota.source}</p>
      </Show>
    </li>
  );
}
