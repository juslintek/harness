import { useState } from "preact/hooks";
import { accountView } from "../../../shared/accounts";
import { addAccountWithLogin, type JsonCaller } from "../../../shared/accounts-ui";
import { accountLoginSchema } from "../../../shared/runs";
import { api } from "../../api";
import { errorText } from "../../format";

const jsonCall: JsonCaller = (path, init) =>
  path.endsWith("/login") ? api(path, accountLoginSchema, init) : api(path, accountView, init);

export function AddAccountForm({
  runtime,
  onAdded,
}: {
  runtime: string;
  onAdded: () => void;
}): preact.JSX.Element {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (!label.trim()) return;
    setBusy(true);
    setMessage(null);
    setCommand(null);
    try {
      const res = await addAccountWithLogin(jsonCall, runtime, label);
      setCommand(res.command);
      setLabel("");
      onAdded();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="inline-form" onSubmit={submit}>
      <label>
        <span>Add {runtime} account</span>
        <input
          type="text"
          value={label}
          placeholder="label (e.g. work-2)"
          onInput={(e) => setLabel(e.currentTarget.value)}
        />
      </label>
      <button type="submit" disabled={busy || !label.trim()}>
        {busy ? "Adding..." : "Add account"}
      </button>
      {command && (
        <p class="muted" role="status">
          Run or finish login: <code>{command}</code>
        </p>
      )}
      {message && (
        <p class="error" role="alert">
          {message}
        </p>
      )}
    </form>
  );
}
