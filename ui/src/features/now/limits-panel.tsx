import { For, type JSX, Show } from "solid-js";
import { ButtonLink, Help, Meter, statusWord } from "../../ui/atoms";
import { Panel } from "../../ui/molecules";
import type { NowData } from "./now-data";

const usd = (n: number): string => `$${n.toFixed(2)}`;

// Only what is close to a limit; the full picture is on Usage & budgets.
export function LimitsPanel(props: { data: NowData; slug: string }): JSX.Element {
  const d = (): NowData => props.data;
  const budgets = () =>
    d()
      .budgets()
      .filter((b) => b.state !== "ok");
  const quota = () =>
    d()
      .quota()
      .filter((q) => (q.usedPercent ?? 0) >= 80);
  return (
    <Panel title="Budgets and limits">
      <div class="now-limits">
        <Show
          when={budgets().length > 0 || quota().length > 0}
          fallback={<Help>Nothing is close to a limit.</Help>}
        >
          <For each={budgets()}>
            {(b) => (
              <Meter
                tone={statusWord(b.state, "budget").tone}
                label={`${d().scopeName(b.scopeKind, b.scopeId)} · ${statusWord(b.state, "budget").word}`}
                value={`${usd(b.spentUsd)} of ${usd(b.monthlyUsd)}`}
                pct={b.ratio * 100}
              />
            )}
          </For>
          <For each={quota()}>
            {(q) => (
              <Meter
                tone={(q.usedPercent ?? 0) >= 100 ? "danger" : "warning"}
                label={`${q.provider} · ${q.window} window`}
                value={`${Math.round(q.usedPercent ?? 0)}% used`}
                pct={q.usedPercent ?? 0}
              />
            )}
          </For>
        </Show>
        <div>
          <ButtonLink href={`#/o/${props.slug}/dashboard`}>Open Usage & budgets</ButtonLink>
        </div>
      </div>
    </Panel>
  );
}
