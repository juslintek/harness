import { type JSX, Show } from "solid-js";
import { Button } from "../../ui/atoms";
import { FacetGroup } from "./facet-chips";
import { type Facets, kindWord, scopeWord } from "./memory-data";

export interface Filters {
  scope: string;
  type: string;
  tag: string;
  source: string;
}
export const NO_FILTERS: Filters = { scope: "", type: "", tag: "", source: "" };

const GROUPS: [keyof Filters, string, keyof Facets][] = [
  ["scope", "Applies to", "scopes"],
  ["type", "Kind", "types"],
  ["tag", "Tags", "tags"],
  ["source", "Written by", "sources"],
];

export const activeCount = (f: Filters): number => Object.values(f).filter(Boolean).length;

// On a phone the chips sit behind a button so search and the list stay in view.
export function NoteFilters(props: {
  facets: Facets;
  filters: Filters;
  open: boolean;
  onToggleOpen: () => void;
  onChange: (next: Filters) => void;
}): JSX.Element {
  return (
    <>
      <Button
        class="memory-filters-button"
        aria-expanded={props.open}
        onClick={() => props.onToggleOpen()}
      >
        Filters
        <Show when={activeCount(props.filters) > 0}> ({activeCount(props.filters)})</Show>
      </Button>
      <div class="memory-filters" data-open={props.open ? "" : undefined}>
        {GROUPS.map(([key, label, facet]) => (
          <FacetGroup
            label={label}
            counts={props.facets[facet]}
            word={key === "scope" ? scopeWord : key === "type" ? kindWord : undefined}
            active={props.filters[key]}
            onToggle={(value) => props.onChange({ ...props.filters, [key]: value })}
          />
        ))}
      </div>
    </>
  );
}
