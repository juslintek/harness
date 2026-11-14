import { For, type JSX } from "solid-js";
import { CountBadge } from "../../ui/atoms";

export const FILTERS = [
  { key: "all", label: "All", kinds: null },
  { key: "messages", label: "Messages", kinds: ["message"] },
  { key: "commands", label: "Commands", kinds: ["tool_call"] },
  { key: "guard", label: "Guard", kinds: ["guard", "permission", "approval"] },
  { key: "errors", label: "Errors", kinds: ["error"] },
] as const;

export type FilterKey = (typeof FILTERS)[number]["key"];

export const matches = (key: FilterKey, kind: string): boolean => {
  const filter = FILTERS.find((f) => f.key === key);
  return !filter?.kinds || (filter.kinds as readonly string[]).includes(kind);
};

export function KindChips(props: {
  current: FilterKey;
  count: (key: FilterKey) => number;
  onPick: (key: FilterKey) => void;
}): JSX.Element {
  return (
    <fieldset class="kind-chips" aria-label="Filter events by kind">
      <For each={FILTERS}>
        {(filter) => (
          <button
            type="button"
            class="kind-chip"
            aria-pressed={props.current === filter.key}
            onClick={() => props.onPick(filter.key)}
          >
            {filter.label}
            <CountBadge count={props.count(filter.key)} />
          </button>
        )}
      </For>
    </fieldset>
  );
}
