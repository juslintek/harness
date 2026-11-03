import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { ignored } from "../auth/me";
import { useAction } from "../auth/use-action";
import { type EffectivePolicy, fields, parseValue, show, toText } from "./policies-data";
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
  const [text, setText] = useState("");
  const action = useAction();
  const here = item.chain.some((c) => c.layer === scope.layer && c.targetId === scope.targetId);
  const base = `/api/orgs/${slug}/policies`;
  const start = (): void => {
    const field = fields[item.key];
    setText(field.kind === "choice" ? String(item.value) : toText(item.value));
    setEditing(true);
  };
  const run = (call: () => Promise<unknown>): void => {
    action
      .run(async () => {
        await call();
        setEditing(false);
        onChanged();
      })
      .catch((err: unknown) => console.error(err));
  };
  const save = (): void => {
    const value = parseValue(item.key, text);
    const body = { layer: scope.layer, targetId: scope.targetId, key: item.key, value };
    run(() => api(base, ignored, { method: "PUT", body }));
  };
  const clear = (): void => {
    const q = `layer=${scope.layer}&targetId=${encodeURIComponent(scope.targetId)}&key=${item.key}`;
    run(() => api(`${base}?${q}`, ignored, { method: "DELETE" }));
  };
  return (
    <li class="card policy-row">
      <div class="policy-head">
        <strong>{item.key}</strong>
        <span class="policy-value">{show(item.value)}</span>
        <span class="badge">from {item.layer}</span>
      </div>
      {editing ? (
        <form
          class="row"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Control item={item} text={text} onText={setText} />
          <button type="submit" disabled={action.busy}>
            Save at {scope.layer} layer
          </button>
          <button type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <div class="row">
          <button type="button" onClick={start}>
            Edit at {scope.layer} layer
          </button>
          {here && (
            <button type="button" class="danger" disabled={action.busy} onClick={clear}>
              Clear at {scope.layer} layer
            </button>
          )}
        </div>
      )}
      <ErrorLine message={action.error} />
      <Chain item={item} />
    </li>
  );
}
