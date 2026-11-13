import { For, type JSX, Show } from "solid-js";

export function FacetGroup(props: {
  label: string;
  counts: Record<string, number>;
  active: string;
  word?: ((name: string) => string) | undefined;
  onToggle: (value: string) => void;
}): JSX.Element {
  const names = (): string[] => Object.keys(props.counts).sort();
  return (
    <Show when={names().length > 0}>
      <fieldset class="memory-facet">
        <legend>{props.label}</legend>
        <div class="memory-chips">
          <For each={names()}>
            {(name) => (
              <button
                type="button"
                class="memory-chip"
                aria-pressed={props.active === name}
                onClick={() => props.onToggle(props.active === name ? "" : name)}
              >
                <Show when={props.active === name}>
                  <span aria-hidden="true">✓</span>
                </Show>
                {props.word ? props.word(name) : name} <span>{props.counts[name]}</span>
              </button>
            )}
          </For>
        </div>
      </fieldset>
    </Show>
  );
}
