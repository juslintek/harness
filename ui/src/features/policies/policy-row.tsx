import type { EffectivePolicy } from "@shared/policies";
import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import { api } from "../../api";
import { ignored } from "../../auth/me";
import { createAction } from "../../ui/action";
import { Button, Help, StatusBadge } from "../../ui/atoms";
import { Field } from "../../ui/molecules";
import { FormError } from "../orgs/shared";
import {
  fields,
  inheritedFrom,
  layerName,
  optionWord,
  type PolicyMeta,
  parseValue,
  policyMeta,
  toText,
  valueWord,
} from "./policies-data";
import type { Scope } from "./scope-picker";

const scopeText = (scope: Scope): string =>
  scope.layer === "org" ? "the whole organisation" : `this ${scope.layer}`;

function AutonomyLevels(): JSX.Element {
  return (
    <div class="autonomy-levels">
      <p>
        <strong>Full.</strong> The guard works as usual: safe commands run, risky ones ask you,
        forbidden ones are blocked.
      </p>
      <p>
        <strong>Supervised.</strong> Like Full, but manager agents may not approve commands. Only
        people can.
      </p>
      <p>
        <strong>Strict.</strong> Like Supervised, and every command that is not a plain read asks
        for approval.
      </p>
      <Help>
        A team or agent can pick the same level or a stricter one, never a looser one. Saving asks
        for your passkey.
      </Help>
    </div>
  );
}

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
  const meta = policyMeta[props.item.key];
  const label = `${meta.name} for ${scopeText(props.scope)}`;
  return (
    <form
      class="policy-edit"
      onSubmit={(e) => {
        e.preventDefault();
        if (props.busy) return;
        const parsed = parseValue(props.item.key, text());
        if (parsed.ok) props.onSave(parsed.value);
        else setInvalid(parsed.message);
      }}
    >
      <Field
        label={field.kind === "list" ? `${label} (comma separated, empty for no limit)` : label}
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
                    {optionWord(props.item.key, o)}
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
      <Show when={props.item.key === "autonomy"}>
        <AutonomyLevels />
      </Show>
      <div class="row-actions">
        <Button type="submit" tone="primary" disabled={props.busy}>
          Save for {layerName[props.scope.layer]}
        </Button>
        <Button onClick={props.onCancel}>Cancel</Button>
      </div>
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
  const action = createAction();
  const base = `/api/orgs/${props.slug}/policies`;
  const meta = (): PolicyMeta => policyMeta[props.item.key];
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
  // No confirm: the value is not lost, the layer above applies again and can be set once more.
  const clear = (): Promise<void> => {
    const q = `layer=${props.scope.layer}&targetId=${encodeURIComponent(props.scope.targetId)}&key=${props.item.key}`;
    return run(() => api(`${base}?${q}`, ignored, { method: "DELETE" }));
  };
  const here = (): boolean =>
    props.item.chain.some(
      (c) => c.layer === props.scope.layer && c.targetId === props.scope.targetId,
    );
  const inherited = (): ReturnType<typeof inheritedFrom> => inheritedFrom(props.item, props.scope);
  const layersLine = (): string =>
    props.item.chain.length === 0
      ? "none set, default applies"
      : [...props.item.chain]
          .reverse()
          .map((c) => `${layerName[c.layer]} ${valueWord(props.item.key, c.value)}`)
          .join(", ");
  return (
    <li class="policy-card">
      <div class="policy-main">
        <div class="policy-what">
          <p class="policy-name">
            {meta().name} <code class="policy-key">{props.item.key}</code>
          </p>
          <Help>{meta().help}</Help>
        </div>
        <div class="policy-now">
          <p class="policy-value">
            {valueWord(props.item.key, props.item.value)}
            <StatusBadge tone="neutral" value={`from ${layerName[props.item.layer]}`} />
          </p>
          <Show when={meta().explain(props.item.value)}>{(text) => <Help>{text()}</Help>}</Show>
          <Help>Layers: {layersLine()}</Help>
        </div>
        <Show when={!editing()}>
          <div class="row-actions policy-actions">
            <Button size="sm" aria-label={`Edit ${meta().name}`} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Show when={here()}>
              <Button size="sm" disabled={action.busy()} onClick={() => void clear()}>
                {`${inherited().layers ? "Use inherited" : "Use default"} (${valueWord(props.item.key, inherited().value)})`}
              </Button>
            </Show>
          </div>
        </Show>
      </div>
      <Show when={editing()}>
        <EditForm
          item={props.item}
          scope={props.scope}
          busy={action.busy()}
          onSave={(v) => void save(v)}
          onCancel={() => setEditing(false)}
        />
      </Show>
      <FormError message={action.error()} />
    </li>
  );
}
