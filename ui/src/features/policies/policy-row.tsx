import type { EffectivePolicy } from "@shared/policies";
import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import { api } from "../../api";
import { ignored } from "../../auth/me";
import { createAction } from "../../ui/action";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { Button, Field, StatusBadge } from "../../ui/primitives";
import { FormError } from "../orgs/shared";
import { fields, parseValue, show, toText } from "./policies-data";
import type { Scope } from "./scope-picker";

function EditForm(props: {
  item: EffectivePolicy;
  scope: Scope;
  busy: boolean;
  onSave: (value: unknown) => void;
  onCancel: () => void;
}): JSX.Element {
  const field = fields[props.item.key];
  const [text, setText] = createSignal(
    field.kind === "choice" ? String(props.item.value) : toText(props.item.value),
  );
  const [invalid, setInvalid] = createSignal<string | null>(null);
  let control: HTMLInputElement | HTMLSelectElement | undefined;
  onMount(() => control?.focus());
  const label = `Value for ${props.item.key}`;
  return (
    <form
      class="form-row"
      onSubmit={(e) => {
        e.preventDefault();
        if (props.busy) return;
        const parsed = parseValue(props.item.key, text());
        if (parsed.ok) props.onSave(parsed.value);
        else setInvalid(parsed.message);
      }}
    >
      <Field
        label={
          field.kind === "list" ? `${label} (comma separated, empty for no restriction)` : label
        }
        error={invalid()}
      >
        {(c) =>
          field.kind === "choice" ? (
            <select
              {...c()}
              ref={(el) => {
                control = el;
              }}
              onChange={(e) => setText(e.currentTarget.value)}
            >
              <For each={field.options}>
                {(o) => (
                  <option value={o} selected={o === text()}>
                    {o}
                  </option>
                )}
              </For>
            </select>
          ) : (
            <input
              {...c()}
              ref={(el) => {
                control = el;
              }}
              type="text"
              inputMode={field.kind === "number" ? "decimal" : "text"}
              value={text()}
              onInput={(e) => {
                setText(e.currentTarget.value);
                setInvalid(null);
              }}
            />
          )
        }
      </Field>
      <Button type="submit" tone="primary" disabled={props.busy}>
        Save at {props.scope.layer} layer
      </Button>
      <Button onClick={props.onCancel}>Cancel</Button>
    </form>
  );
}

export function PolicyRow(props: {
  item: EffectivePolicy;
  scope: Scope;
  slug: string;
  onChanged: () => void;
}): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  const [clearing, setClearing] = createSignal(false);
  const action = createAction();
  const base = `/api/orgs/${props.slug}/policies`;
  const run = (call: () => Promise<unknown>): Promise<void> =>
    action.run(async () => {
      await call();
      setEditing(false);
      props.onChanged();
    });
  const save = (value: unknown): Promise<void> =>
    run(() =>
      api(base, ignored, {
        method: "PUT",
        body: {
          layer: props.scope.layer,
          targetId: props.scope.targetId,
          key: props.item.key,
          value,
        },
      }),
    );
  const clear = (): Promise<void> => {
    const q = `layer=${props.scope.layer}&targetId=${encodeURIComponent(props.scope.targetId)}&key=${props.item.key}`;
    return run(() => api(`${base}?${q}`, ignored, { method: "DELETE" }));
  };
  const here = (): boolean =>
    props.item.chain.some(
      (c) => c.layer === props.scope.layer && c.targetId === props.scope.targetId,
    );
  return (
    <li class="policy-card">
      <div class="policy-head">
        <span class="policy-key">{props.item.key}</span>
        <span class="policy-value">{show(props.item.value)}</span>
        <StatusBadge tone="neutral" value={`from ${props.item.layer}`} />
      </div>
      <Show
        when={editing()}
        fallback={
          <div class="row-actions">
            <Button
              size="sm"
              aria-label={`Edit ${props.item.key} at ${props.scope.layer} layer`}
              onClick={() => setEditing(true)}
            >
              Edit at {props.scope.layer} layer
            </Button>
            <Show when={here()}>
              <Button
                size="sm"
                tone="danger"
                aria-label={`Clear ${props.item.key} at ${props.scope.layer} layer`}
                disabled={action.busy()}
                onClick={() => setClearing(true)}
              >
                Clear at {props.scope.layer} layer
              </Button>
            </Show>
          </div>
        }
      >
        <EditForm
          item={props.item}
          scope={props.scope}
          busy={action.busy()}
          onSave={(v) => void save(v)}
          onCancel={() => setEditing(false)}
        />
      </Show>
      <FormError message={action.error()} />
      <details class="policy-chain">
        <summary>Chain ({props.item.chain.length})</summary>
        <Show
          when={props.item.chain.length > 0}
          fallback={<p class="muted-line">Nothing set; the built-in default applies.</p>}
        >
          <ol>
            <For each={props.item.chain}>
              {(c) => (
                <li>
                  {c.layer}: {show(c.value)}
                </li>
              )}
            </For>
          </ol>
        </Show>
      </details>
      <ConfirmDialog
        open={clearing()}
        title={`Clear ${props.item.key}?`}
        message={`The ${props.scope.layer} layer stops setting this policy. The next layer up applies again.`}
        confirm="Clear policy"
        onClose={() => setClearing(false)}
        onConfirm={() => {
          setClearing(false);
          void clear();
        }}
      />
    </li>
  );
}
