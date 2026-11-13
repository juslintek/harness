import { type JSX, type ParentProps, Show } from "solid-js";
import { Help } from "../../ui/atoms";
import { Notice } from "../../ui/molecules";
import { isPublicProvider, type Provider } from "./tunnel-logic";

export function ProviderOption(
  props: ParentProps<{
    id: Provider;
    label: string;
    start: string;
    stop: string | null;
    checked: boolean;
    disabled: boolean;
    onSelect: () => void;
  }>,
): JSX.Element {
  return (
    <div class="int-choice">
      <label>
        <input
          type="radio"
          name="tunnel-provider"
          checked={props.checked}
          disabled={props.disabled}
          onChange={props.onSelect}
        />
        {props.label}
      </label>
      <Help small>
        Runs: <code>{props.start}</code>
      </Help>
      <Show when={isPublicProvider(props.id)}>
        <Notice tone="warning" title="This makes the instance reachable from the internet" standing>
          Anyone who has the address can reach the sign-in page. Signing in still needs a passkey.
        </Notice>
      </Show>
      {props.children}
    </div>
  );
}
