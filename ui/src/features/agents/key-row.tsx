import type { KeyStatus } from "@shared/runs";
import { createSignal, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { createAction } from "../../ui/action";
import { Button, StatusBadge } from "../../ui/atoms";
import { Field } from "../../ui/molecules";

const okSchema = z.object({ ok: z.literal(true) });
const NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  openrouter: "OpenRouter",
};
const SOURCE = { env: "from the environment", file: "from the harness secrets file" } as const;

// The server never returns a stored key: a set key shows "Key set" and where it comes from, and
// the field only appears to replace it. `saved` lives in the parent because a reload rebuilds rows.
export function KeyRow(props: {
  item: KeyStatus;
  saved: boolean;
  onSaved: () => void;
}): JSX.Element {
  const [value, setValue] = createSignal("");
  const [editing, setEditing] = createSignal(false);
  const save = createAction();
  const name = (): string => NAMES[props.item.provider] ?? props.item.provider;
  const isSet = (): boolean => props.item.source !== null;
  const submit = (e: SubmitEvent): void => {
    e.preventDefault();
    void save.run(async () => {
      await api(`/api/agents/keys/${props.item.provider}`, okSchema, {
        method: "POST",
        body: { key: value() },
      });
      setValue("");
      setEditing(false);
      props.onSaved();
    });
  };
  return (
    <form class="key-form" onSubmit={submit}>
      <div class="cli-head">
        <span class="key-name">{name()}</span>
        <Show when={props.item.source} fallback={<StatusBadge tone="neutral" value="No key set" />}>
          {(source) => (
            <>
              <StatusBadge tone="success" value="Key set" />
              <span class="muted">{SOURCE[source()]}</span>
            </>
          )}
        </Show>
        <Show when={isSet() && !editing()}>
          <Button size="sm" onClick={() => setEditing(true)}>
            Replace key
          </Button>
        </Show>
      </div>
      <Show when={props.item.legacyLeft}>
        <p class="error">Key also left in login keychain</p>
      </Show>
      <Show when={!isSet() || editing()}>
        <div class="key-row">
          <Field label={`${name()} API key`}>
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
      </Show>
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
