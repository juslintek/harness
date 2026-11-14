import type { MemberReport } from "@shared/tracking";
import { type JSX, Show } from "solid-js";

const nf = new Intl.NumberFormat("en");
const min = (ms: number): string => nf.format(Math.round(ms / 60_000));

export function MemberRow(props: { member: MemberReport }): JSX.Element {
  const m = (): MemberReport => props.member;
  return (
    <tr>
      <th scope="row">{m().handle}</th>
      <td data-label="Runs done">
        {m().completed} of {m().runs}
      </td>
      <td class="num" data-label="Tokens in">
        {nf.format(m().inputTokens)}
      </td>
      <td class="num" data-label="Tokens out">
        {nf.format(m().outputTokens)}
      </td>
      <td data-label="Cost (USD)">
        {/* "~" marks a cost the registry priced; unpriced events keep a low total from reading as final. */}
        {m().costEstimated ? "~" : ""}${m().costUsd.toFixed(2)}
        <Show when={m().unpricedEvents > 0}>
          <span class="dashboard-note"> + {m().unpricedEvents} unpriced</span>
        </Show>
      </td>
      <td data-label="Active (min)">{min(m().activeMs)}</td>
      <td data-label="Waiting (min)">{min(m().waitingMs)}</td>
      <td data-label="Wall (min)">{min(m().wallMs)}</td>
      <td class="dashboard-tools" data-label="Top tools">
        {m()
          .tools.slice(0, 3)
          .map((t) => `${t.name} ${t.count}`)
          .join(", ") || "-"}
      </td>
    </tr>
  );
}
