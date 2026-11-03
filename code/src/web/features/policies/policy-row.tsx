import { useEffect, useRef, useState } from "preact/hooks";
import type { EffectivePolicy, PolicyKey } from "../../../shared/policies";
import { api } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { ignored } from "../auth/me";
import { type Action, useAction } from "../auth/use-action";
import { fields, parseValue, show, toText } from "./policies-data";
import type { Scope } from "./scope-picker";

function Control({
  item,
  text,
  onText,
}: {
  item: EffectivePolicy;
  text: string;
  onText: (text: string) => void;
}): preact.JSX.Element {
  const field = fields[item.key];
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const label = `Value for ${item.key}`;
  if (field.kind === "choice") {
    return (
      <label>
        {label}
        <select ref={ref} value={text} onChange={(e) => onText(e.currentTarget.value)}>
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label>
      {field.kind === "list" ? `${label} (comma separated, empty for no restriction)` : label}
      <input
        ref={ref}
        type="text"
        inputMode={field.kind === "number" ? "decimal" : "text"}
        value={text}
        onInput={(e) => onText(e.currentTarget.value)}
      />
    </label>
  );
}

function Chain({ item }: { item: EffectivePolicy }): preact.JSX.Element {
  return (
    <details>
      <summary>Chain ({item.chain.length})</summary>
      {item.chain.length === 0 ? (
        <p class="muted">Nothing set; the built-in default applies.</p>
      ) : (
        <ol>
          {item.chain.map((c) => (
            <li key={`${c.layer}/${c.targetId}`}>
              {c.layer}: {show(c.value)}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

function EditForm({
  item,
  scope,
  busy,
  onSave,
  onCancel,
}: {
  item: EffectivePolicy;
  scope: Scope;
  busy: boolean;
  onSave: (value: unknown) => void;
  onCancel: () => void;
}): preact.JSX.Element {
  const field = fields[item.key];
  const [text, setText] = useState(
    field.kind === "choice" ? String(item.value) : toText(item.value),
  );
  const [invalid, setInvalid] = useState<string | null>(null);
  const submit = (): void => {
    const parsed = parseValue(item.key, text);
    if (parsed.ok) onSave(parsed.value);
    else setInvalid(parsed.message);
  };
  return (
    <form
      class="row"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Control item={item} text={text} onText={setText} />
      <button type="submit" disabled={busy}>
        Save at {scope.layer} layer
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      <ErrorLine message={invalid} />
    </form>
  );
}

function Actions({
  item,
  scope,
  busy,
  onEdit,
  onClear,
}: {
  item: EffectivePolicy;
  scope: Scope;
  busy: boolean;
  onEdit: () => void;
  onClear: () => void;
}): preact.JSX.Element {
  const here = item.chain.some((c) => c.layer === scope.layer && c.targetId === scope.targetId);
  return (
    <div class="row">
      <button
        type="button"
        aria-label={`Edit ${item.key} at ${scope.layer} layer`}
        onClick={onEdit}
      >
        Edit at {scope.layer} layer
      </button>
      {here && (
        <button
          type="button"
          class="danger"
          aria-label={`Clear ${item.key} at ${scope.layer} layer`}
          disabled={busy}
          onClick={onClear}
        >
          Clear at {scope.layer} layer
        </button>
      )}
    </div>
  );
}

function usePolicyWrites(
  slug: string,
  scope: Scope,
  key: PolicyKey,
  onDone: () => void,
): { action: Action; save: (value: unknown) => void; clear: () => void } {
  const action = useAction();
  const base = `/api/orgs/${slug}/policies`;
  const run = (call: () => Promise<unknown>): void => {
    action
      .run(async () => {
        await call();
        onDone();
      })
      .catch((err: unknown) => console.error(err));
  };
  const save = (value: unknown): void => {
    const body = { layer: scope.layer, targetId: scope.targetId, key, value };
    run(() => api(base, ignored, { method: "PUT", body }));
  };
  const clear = (): void => {
    const q = `layer=${scope.layer}&targetId=${encodeURIComponent(scope.targetId)}&key=${key}`;
    run(() => api(`${base}?${q}`, ignored, { method: "DELETE" }));
  };
  return { action, save, clear };
}

export function PolicyRow({
  item,
  scope,
  slug,
  onChanged,
}: {
  item: EffectivePolicy;
  scope: Scope;
  slug: string;
  onChanged: () => void;
}): preact.JSX.Element {
  const [editing, setEditing] = useState(false);
  const { action, save, clear } = usePolicyWrites(slug, scope, item.key, () => {
    setEditing(false);
    onChanged();
  });
  return (
    <li class="card policy-row">
      <div class="policy-head">
        <strong>{item.key}</strong>
        <span class="policy-value">{show(item.value)}</span>
        <span class="badge">from {item.layer}</span>
      </div>
      {editing ? (
        <EditForm
          item={item}
          scope={scope}
          busy={action.busy}
          onSave={save}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <Actions
          item={item}
          scope={scope}
          busy={action.busy}
          onEdit={() => setEditing(true)}
          onClear={clear}
        />
      )}
      <ErrorLine message={action.error} />
      <Chain item={item} />
    </li>
  );
}
