import { useState } from "preact/hooks";
import { api } from "../../api";
import { CopyButton } from "../../copy-button";
import { ErrorLine } from "../auth/error-line";
import { useAction } from "../auth/use-action";
import { createdSchema, orgUrl, webhookAddedSchema } from "./notify-data";

interface ValueFormProps {
  channel: "email" | "slack";
  org: string;
  field: "address" | "userId";
  label: string;
  hint: string;
  onAdded: () => void;
}

export function ValueForm(props: ValueFormProps): preact.JSX.Element {
  const [value, setValue] = useState("");
  const action = useAction();
  const submit = (e: Event): void => {
    e.preventDefault();
    action
      .run(async () => {
        const body = { channel: props.channel, value: { [props.field]: value.trim() } };
        await api(orgUrl("/api/notify/targets", props.org), createdSchema, {
          method: "POST",
          body,
        });
        setValue("");
        props.onAdded();
      })
      .catch((err: unknown) => console.error(err));
  };
  const shared = {
    value,
    required: true,
    maxLength: 320,
    onInput: (e: preact.TargetedEvent<HTMLInputElement>) => setValue(e.currentTarget.value),
  };
  return (
    <form class="row" onSubmit={submit}>
      <label>
        {props.label}
        <input
          {...shared}
          inputMode={props.channel === "email" ? "email" : "text"}
          autoComplete="off"
        />
      </label>
      <button type="submit" disabled={action.busy}>
        Add
      </button>
      <p class="muted hint">{props.hint}</p>
      <ErrorLine message={action.error} />
    </form>
  );
}

// The secret is only in this component's state: closing the box drops it for good.
function SecretOnce({
  secret,
  note,
  onDone,
}: {
  secret: string;
  note: string;
  onDone: () => void;
}): preact.JSX.Element {
  return (
    <div class="card secret-once" role="status">
      <p>
        <strong>Copy this signing secret now.</strong> It is shown only once and cannot be read back
        later.
      </p>
      <p class="muted">{note}</p>
      <div class="row">
        <label>
          Signing secret
          <input readOnly value={secret} onFocus={(e) => e.currentTarget.select()} />
        </label>
        <CopyButton text={secret} label="Copy the webhook signing secret" />
        <button type="button" onClick={onDone}>
          I have saved it
        </button>
      </div>
    </div>
  );
}

export function WebhookForm({
  org,
  onAdded,
}: {
  org: string;
  onAdded: () => void;
}): preact.JSX.Element {
  const [url, setUrl] = useState("");
  const [added, setAdded] = useState<{ secret: string; note: string } | null>(null);
  const action = useAction();
  const submit = (e: Event): void => {
    e.preventDefault();
    action
      .run(async () => {
        const body = { channel: "webhook", url: url.trim() };
        setAdded(
          await api(orgUrl("/api/notify/targets", org), webhookAddedSchema, {
            method: "POST",
            body,
          }),
        );
        setUrl("");
        onAdded();
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <>
      {added && <SecretOnce {...added} onDone={() => setAdded(null)} />}
      <form class="row" onSubmit={submit}>
        <label>
          Webhook URL
          <input
            type="url"
            value={url}
            required
            maxLength={2000}
            placeholder="https://example.com/harness-hook"
            onInput={(e) => setUrl(e.currentTarget.value)}
          />
        </label>
        <button type="submit" disabled={action.busy}>
          Add
        </button>
        <ErrorLine message={action.error} />
      </form>
    </>
  );
}
