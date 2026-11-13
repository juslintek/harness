import type { RunView } from "@shared/runs";
import { For, type JSX, Show } from "solid-js";
import { StatusBadge } from "../../ui/atoms";
import { TableBox } from "../../ui/molecules";
import type { NowData } from "./now-data";
import { NowSection } from "./now-section";
import { hhmm } from "./time";

const RESULT: Record<string, string> = {
  rate_limited: "The provider's rate limit or quota was reached.",
  killed_by_user: "Stopped by a person.",
  halted: "Stopped when agents were stopped.",
  guard_denied: "A command was denied by the guard.",
  approval_timeout: "An approval expired before anyone decided.",
  max_tokens: "The model reached its output limit.",
  budget_exhausted: "The budget was used up.",
};

const result = (r: RunView): string =>
  r.reason ? (RESULT[r.reason] ?? r.reason.replaceAll("_", " ")) : "Finished.";

// Instance admins only: the run list is theirs, so the page leaves this block out for everyone else.
export function FinishedToday(props: { data: NowData }): JSX.Element {
  const d = (): NowData => props.data;
  return (
    <NowSection title="Finished today" count={d().finished().length}>
      <Show
        when={d().finished().length > 0}
        fallback={<p class="now-empty-line">No run has finished today.</p>}
      >
        <TableBox stack label="Finished today">
          <thead>
            <tr>
              <th scope="col">Status</th>
              <th scope="col">Run</th>
              <th scope="col">Agent</th>
              <th scope="col">Ended</th>
              <th scope="col">Tokens</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            <For each={d().finished()}>
              {(r) => (
                <tr class="now-finished-row">
                  <td data-label="Status">
                    <StatusBadge kind="run" value={r.state} />
                  </td>
                  <td data-label="Run" class="mono">
                    <a href={`#/runs/${r.id}`}>{r.id}</a>
                  </td>
                  <td data-label="Agent">@{d().handleOf(r.memberId) ?? r.agentId}</td>
                  <td data-label="Ended" class="mono">
                    {hhmm(r.endedAt ?? r.createdAt)}
                  </td>
                  <td data-label="Tokens" class="mono">
                    {(r.inputTokens + r.outputTokens).toLocaleString("en-US")}
                  </td>
                  <td data-label="Result">{result(r)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </TableBox>
      </Show>
    </NowSection>
  );
}
