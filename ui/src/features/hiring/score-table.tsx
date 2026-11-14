import type { HireView } from "@shared/hiring";
import { For, type JSX, Show } from "solid-js";
import { StatusBadge } from "../../ui/atoms";
import { TableBox } from "../../ui/molecules";

export type Candidate = HireView["candidates"][number];

export const engineName = (c: Candidate): string =>
  `${c.profile.runtime}${c.profile.model ? ` / ${c.profile.model}` : ""}`;

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

export function reviewersAverage(c: Candidate, reviewers: number): string {
  const n = c.scorecards.length;
  if (n === 0) return "no scorecards yet";
  const avg = mean(c.scorecards.map((s) => mean([s.fit, s.depth, s.honesty])));
  return `${avg.toFixed(1)} (${n <= reviewers ? `${n} of ${reviewers} reviewers` : `${n} scorecards`})`;
}

// Side by side so the scores can be compared; `action` adds one button per row for the decision.
export function ScoreTable(props: {
  hire: HireView;
  label: string;
  action?: (c: Candidate) => JSX.Element;
}): JSX.Element {
  return (
    <TableBox stack label={props.label}>
      <thead>
        <tr>
          <th>Candidate</th>
          <th>Status</th>
          <th>System score</th>
          <th>Reviewers' average</th>
          <th>Total</th>
          <th>Limits it states</th>
          <Show when={props.action}>
            <th>
              <span class="sr-only">Action</span>
            </th>
          </Show>
        </tr>
      </thead>
      <tbody>
        <For each={props.hire.candidates}>
          {(c) => (
            <tr>
              <th scope="row" class="mono">
                {engineName(c)}
              </th>
              <td data-label="Status">
                <StatusBadge kind="candidate" value={c.status} />
              </td>
              <td data-label="System score">
                {c.systemScore === null ? "not scored" : `${c.systemScore.toFixed(1)} of 5`}
              </td>
              <td data-label="Reviewers' average">
                {reviewersAverage(c, props.hire.reviewers.length)}
              </td>
              <td data-label="Total">{c.total?.toFixed(1) ?? "not yet"}</td>
              <td data-label="Limits it states">
                {c.profile.card?.limits.join(", ") || "none stated"}
              </td>
              <Show when={props.action}>{(action) => <td>{action()(c)}</td>}</Show>
            </tr>
          )}
        </For>
      </tbody>
    </TableBox>
  );
}
