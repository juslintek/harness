import type { AccountView } from "@shared/accounts";
import { poolSummary } from "@shared/accounts-ui";
import type { RouteDecisionView } from "@shared/router";
import type { AgentRow, QuotaRow } from "@shared/runs";
import { For, type JSX, Show } from "solid-js";
import { StatusBadge } from "../../ui/atoms";
import { Panel, TableBox } from "../../ui/molecules";

export function PoolPanel(props: {
  agents: AgentRow[];
  accountsByRuntime: Record<string, AccountView[]>;
  quota: QuotaRow[];
  decisions: RouteDecisionView[];
}): JSX.Element {
  const summaries = () =>
    props.agents
      .filter(
        (a) =>
          a.installed ||
          (props.accountsByRuntime[a.id]?.some((acct) => acct.state !== "removed") ?? false),
      )
      .map((a) => poolSummary(a.id, props.accountsByRuntime[a.id] ?? [], props.quota));

  return (
    <Panel title="Account pool health">
      <Show
        when={summaries().length > 0}
        fallback={<p class="muted">No runtimes in the pool yet.</p>}
      >
        <TableBox stack label="Pool status by runtime">
          <thead>
            <tr>
              <th scope="col">Runtime</th>
              <th scope="col">Eligible / Total</th>
              <th scope="col">Exhausted</th>
              <th scope="col">Next pick</th>
            </tr>
          </thead>
          <tbody>
            <For each={summaries()}>
              {(s) => (
                <tr>
                  <th scope="row">{s.runtime}</th>
                  <td data-label="Eligible / Total" class="mono">
                    {s.eligibleCount} / {s.totalCount}
                  </td>
                  <td data-label="Exhausted" class="mono">
                    {s.exhaustedCount}
                  </td>
                  <td data-label="Next pick">
                    <Show
                      when={s.nextLabel}
                      fallback={
                        <StatusBadge
                          tone={
                            s.exhaustedCount > 0
                              ? "danger"
                              : s.totalCount === 0
                                ? "neutral"
                                : "warning"
                          }
                          value={
                            s.exhaustedCount > 0
                              ? "pool exhausted"
                              : s.totalCount === 0
                                ? "no accounts"
                                : "none eligible"
                          }
                        />
                      }
                    >
                      {(label) => <StatusBadge tone="success" value={label()} />}
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </TableBox>
      </Show>
      <Show when={props.decisions.length > 0}>
        <details class="pool-decisions">
          <summary>Recent route decisions ({props.decisions.length})</summary>
          <ul class="cli-models">
            <For each={props.decisions}>
              {(d) => (
                <li>
                  <code>{d.policy}</code> -&gt; <code>{d.chosenAccount ?? "none"}</code> (
                  {d.totalCandidates} candidates)
                </li>
              )}
            </For>
          </ul>
        </details>
      </Show>
    </Panel>
  );
}
