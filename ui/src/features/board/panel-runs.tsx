import { For, type JSX, Show } from "solid-js";
import { StatusBadge } from "../../ui/atoms";
import { type Wakeup, wakeReason } from "../../wakeups";
import { isInstanceAdmin } from "./wakeups";

const fmtClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// Today's runs show just the time; older ones add the day.
const fmtWhen = (ms: number): string =>
  new Date(ms).toDateString() === new Date().toDateString()
    ? fmtClock(ms)
    : `${new Date(ms).toLocaleDateString([], { day: "numeric", month: "short" })} ${fmtClock(ms)}`;

// One row per time an agent was asked to work on the task. The run id arrives with the wakeup, not
// with the Run now answer, so a fresh row says "no run yet".
export function PanelRuns(props: { wakeups: () => Wakeup[] }): JSX.Element {
  return (
    <Show when={props.wakeups().length > 0}>
      <section class="bd-panel-section" aria-label="Runs">
        <h3>Runs</h3>
        <ul class="bd-plain bd-rows">
          <For each={props.wakeups()}>
            {(w) => (
              <li class="bd-run-row">
                <div class="bd-run-text">
                  <span>{wakeReason(w)}</span>
                  <span class="bd-mono muted">
                    <Show when={w.runId} fallback="no run yet">
                      {(runId) => (
                        <Show when={isInstanceAdmin()} fallback={runId()}>
                          <a href={`#/runs/${runId()}`}>{runId()}</a>
                        </Show>
                      )}
                    </Show>
                    {" · "}
                    {w.endedAt
                      ? `${fmtWhen(w.startedAt ?? w.createdAt)} to ${fmtClock(w.endedAt)}`
                      : `${w.startedAt ? "started" : "asked"} ${fmtWhen(w.startedAt ?? w.createdAt)}`}
                  </span>
                </div>
                <StatusBadge kind="wakeup" value={w.status} />
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}
