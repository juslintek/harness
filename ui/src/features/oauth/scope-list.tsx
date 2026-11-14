import { For, type JSX } from "solid-js";
import { Checkbox } from "../../ui/atoms";

export function ScopeList(props: {
  legend: string;
  scopes: { key: string; label: string }[];
  granted: string[];
  onToggle: (scope: string) => void;
}): JSX.Element {
  return (
    <fieldset class="consent-scopes">
      <legend>{props.legend}</legend>
      <For each={props.scopes}>
        {(scope) => (
          <Checkbox
            checked={props.granted.includes(scope.key)}
            onChange={() => props.onToggle(scope.key)}
            label={scope.label}
          />
        )}
      </For>
    </fieldset>
  );
}
