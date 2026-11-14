import { keyStatusSchema } from "@shared/runs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { createLoad } from "../../load";
import { Help } from "../../ui/atoms";
import { Panel } from "../../ui/molecules";
import { KeyRow } from "./key-row";

const keysSchema = z.array(keyStatusSchema);

export function KeyForm(): JSX.Element {
  const keys = createLoad("/api/agents/keys", keysSchema);
  const [savedFor, setSavedFor] = createSignal<string | null>(null);
  return (
    <div class="keys-panel">
      <Panel title="API keys">
        <div class="keys-body">
          <Help>
            A saved key is never shown again. To change it, press Replace key and paste a new one
            (at least 20 characters). Saving asks for your passkey.
          </Help>
          <Show when={keys.error()}>{(message) => <p class="error">{message()}</p>}</Show>
          <For each={keys.data()}>
            {(item) => (
              <KeyRow
                item={item}
                saved={savedFor() === item.provider}
                onSaved={() => {
                  setSavedFor(item.provider);
                  void keys.reload();
                }}
              />
            )}
          </For>
        </div>
      </Panel>
    </div>
  );
}
