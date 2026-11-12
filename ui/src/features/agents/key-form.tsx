import { type KeyStatus, keyStatusSchema } from "@shared/runs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { Button, Field, Panel } from "../../ui/primitives";

const keysSchema = z.array(keyStatusSchema);
const okSchema = z.object({ ok: z.literal(true) });

// The server never returns a stored key; the form only shows where the key comes from.
// `saved` lives in the parent: a reload replaces the row objects, which rebuilds this form.
function KeyItem(props: { item: KeyStatus; saved: boolean; onSaved: () => void }): JSX.Element {
  const [value, setValue] = createSignal("");
  const save = createAction();
  const submit = (e: SubmitEvent): void => {
    e.preventDefault();
    void save.run(async () => {
      await api(`/api/agents/keys/${props.item.provider}`, okSchema, {
        method: "POST",
        body: { key: value() },
      });
      setValue("");
      props.onSaved();
    });
  };
  return (
    <form class="key-form" onSubmit={submit}>
      <h3>{props.item.provider}</h3>
      <p class="muted">
        Source:{" "}
        {props.item.source === "file" ? "harness secrets file" : (props.item.source ?? "none")}
      </p>
      <Show when={props.item.legacyLeft}>
        <p class="error">Key also left in login keychain</p>
      </Show>
      <div class="key-row">
        <Field label={`${props.item.provider} API key`}>
          {(control) => (
            <input
              {...control()}
              type="password"
              autocomplete="off"
              value={value()}
              minLength={20}
              required
              onInput={(e) => setValue(e.currentTarget.value)}
            />
          )}
        </Field>
        <Button type="submit" tone="primary" disabled={save.busy()}>
          Save key
        </Button>
      </div>
      <Show when={props.saved}>
        <p role="status" class="muted">
          Saved.
        </p>
      </Show>
      <Show when={save.error()}>
        {(message) => (
          <p role="alert" class="error">
            {message()}
          </p>
        )}
      </Show>
    </form>
  );
}

export function KeyForm(): JSX.Element {
  const keys = createLoad("/api/agents/keys", keysSchema);
  const [savedFor, setSavedFor] = createSignal<string | null>(null);
  return (
    <div class="keys-panel">
      <Panel title="API keys">
        <div class="keys-body">
          <Show when={keys.error()}>{(message) => <p class="error">{message()}</p>}</Show>
          <For each={keys.data()}>
            {(item) => (
              <KeyItem
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
