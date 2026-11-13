import { For, type JSX } from "solid-js";
import { Field } from "../../ui/molecules";

export interface Filters {
  assignee: string;
  text: string;
  heldByAgent: boolean;
}

export const NO_FILTER: Filters = { assignee: "", text: "", heldByAgent: false };

export function BoardFilters(props: {
  value: () => Filters;
  onChange: (next: Filters) => void;
  handles: () => string[];
}): JSX.Element {
  const set = (patch: Partial<Filters>): void => props.onChange({ ...props.value(), ...patch });
  return (
    <div class="bd-filters">
      <Field label="Assignee">
        {(control) => (
          <select {...control()} onChange={(e) => set({ assignee: e.currentTarget.value })}>
            <option value="" selected={props.value().assignee === ""}>
              Everyone
            </option>
            <For each={props.handles()}>
              {(handle) => (
                <option value={handle} selected={props.value().assignee === handle}>
                  @{handle}
                </option>
              )}
            </For>
          </select>
        )}
      </Field>
      <Field label="Filter">
        {(control) => (
          <input
            {...control()}
            type="search"
            placeholder="Title or number"
            value={props.value().text}
            onInput={(e) => set({ text: e.currentTarget.value })}
          />
        )}
      </Field>
      <button
        type="button"
        class="bd-chip"
        aria-pressed={props.value().heldByAgent}
        onClick={() => set({ heldByAgent: !props.value().heldByAgent })}
      >
        Held by an agent
      </button>
    </div>
  );
}
