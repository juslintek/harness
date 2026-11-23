import type { AccountView } from "../../../shared/accounts";
import { poolSummary } from "../../../shared/accounts-ui";
import type { RouteDecisionView } from "../../../shared/router";
import type { AgentRow, QuotaRow } from "../../../shared/runs";

export function PoolPanel({
  agents,
  accountsByRuntime,
  quota,
  decisions,
}: {
  agents: AgentRow[];
  accountsByRuntime: Record<string, AccountView[]>;
  quota: QuotaRow[];
  decisions: RouteDecisionView[];
}): preact.JSX.Element {
  const summaries = agents
    .filter(
      (a) =>
        a.installed || (accountsByRuntime[a.id]?.some((acct) => acct.state !== "removed") ?? false),
    )
    .map((a) => poolSummary(a.id, accountsByRuntime[a.id] ?? [], quota));

  return (
    <section>
      <h3>Account Pool Health</h3>
      {summaries.length === 0 ? (
        <p class="muted">No runtimes in the pool yet.</p>
      ) : (
        <table class="stack">
          <thead>
            <tr>
              <th>Runtime</th>
              <th>Eligible / Total</th>
              <th>Exhausted</th>
              <th>Next pick</th>
            </tr>
          </thead>
          <tbody>
            {summaries.map((s) => (
              <tr key={s.runtime}>
                <th scope="row">{s.runtime}</th>
                <td data-label="Eligible / Total">
                  {s.eligibleCount} / {s.totalCount}
                </td>
                <td data-label="Exhausted">{s.exhaustedCount}</td>
                <td data-label="Next pick">
                  {s.nextLabel ??
                    (s.exhaustedCount > 0
                      ? "none (pool exhausted)"
                      : s.totalCount === 0
                        ? "no accounts"
                        : "none eligible")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {decisions.length > 0 && (
        <details>
          <summary>Recent route decisions ({decisions.length})</summary>
          <ul class="plain">
            {decisions.map((d) => (
              <li key={d.id}>
                <code>{d.policy}</code> -&gt; <code>{d.chosenAccount ?? "none"}</code> (
                {d.totalCandidates} candidates)
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
