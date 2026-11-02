import { useState } from "preact/hooks";
import { z } from "zod";
import { type KeyStatus, keyStatusSchema } from "../../../shared/runs";
import { api, useLoad } from "../../api";
import { errorText } from "../../format";

const keysSchema = z.array(keyStatusSchema);
const okSchema = z.object({ ok: z.literal(true) });

// The server never returns a stored key; the form only shows where the key comes from.
function KeyItem({ item, reload }: { item: KeyStatus; reload: () => void }): preact.JSX.Element {
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const save = async (e: Event): Promise<void> => {
    e.preventDefault();
    try {
      await api(`/api/agents/keys/${item.provider}`, okSchema, {
        method: "POST",
        body: { key: value },
      });
      setValue("");
      setMessage("Saved.");
      reload();
    } catch (err) {
      setMessage(errorText(err));
    }
  };
  return (
    <form class="card" onSubmit={save}>
      <h4>{item.provider}</h4>
      <p class="muted">
        Source: {item.source === "file" ? "harness secrets file" : (item.source ?? "none")}
      </p>
      {item.legacyLeft && <p class="error">Key also left in login keychain</p>}
      <label>
        {item.provider} API key
        <input
          type="password"
          autocomplete="off"
          value={value}
          minLength={20}
          required
          onInput={(e) => setValue(e.currentTarget.value)}
        />
      </label>
      <button type="submit">Save key</button>
      {message && (
        <p role="status" class="muted">
          {message}
        </p>
      )}
    </form>
  );
}

export function KeyForm(): preact.JSX.Element {
  const keys = useLoad(() => api("/api/agents/keys", keysSchema), []);
  return (
    <section aria-labelledby="keys-title">
      <h3 id="keys-title">API keys</h3>
      {keys.error && <p class="error">{keys.error}</p>}
      {(keys.data ?? []).map((item) => (
        <KeyItem key={item.provider} item={item} reload={keys.reload} />
      ))}
    </section>
  );
}
