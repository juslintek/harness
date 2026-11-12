import { createSignal, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { createAction } from "../../ui/action";
import { CopyButton } from "../../ui/copy-button";
import { Button, Field } from "../../ui/primitives";
import { createdSchema, orgUrl, webhookAddedSchema } from "./data";

export function ValueForm(props: {
  channel: "email" | "slack";
  org: string;
  field: "address" | "userId";
  label: string;
  hint: string;
  onAdded: () => void;
}): JSX.Element {
  const [value, setValue] = createSignal("");
  const action = createAction();
  const submit = (e: SubmitEvent): void => {
    e.preventDefault();
    void action.run(async () => {
      const body = { channel: props.channel, value: { [props.field]: value().trim() } };
      await api(orgUrl("/api/notify/targets", props.org), createdSchema, { method: "POST", body });
      setValue("");
      props.onAdded();
    });
  };
  return (
    <form class="nf-form" onSubmit={submit}>
      <div class="nf-row nf-row-end">
        <Field label={props.label}>
          {(control) => (
            <input
              {...control()}
              value={value()}
              required
              maxLength={320}
              inputMode={props.channel === "email" ? "email" : "text"}
              autocomplete="off"
              onInput={(e) => setValue(e.currentTarget.value)}
            />
          )}
        </Field>
        <Button type="submit" disabled={action.busy()}>
          Add
        </Button>
      </div>
      <p class="nf-hint">{props.hint}</p>
      <ErrorLine message={action.error()} />
    </form>
  );
}

// The secret is only in this component's state: closing the box drops it for good.
function SecretOnce(props: { secret: string; note: string; onDone: () => void }): JSX.Element {
  return (
    <div class="nf-once" role="status">
      <p>
        <strong>Copy this signing secret now.</strong> It is shown only once and cannot be read back
        later.
      </p>
      <p class="nf-hint">{props.note}</p>
      <div class="nf-row nf-row-end">
        <Field label="Signing secret">
          {(control) => (
            <input
              {...control()}
              class="mono"
              readOnly
              value={props.secret}
              onFocus={(e) => e.currentTarget.select()}
            />
          )}
        </Field>
        <CopyButton text={props.secret} label="Copy the webhook signing secret" />
        <Button onClick={props.onDone}>I have saved it</Button>
      </div>
    </div>
  );
}

export function WebhookForm(props: { org: string; onAdded: () => void }): JSX.Element {
  const [url, setUrl] = createSignal("");
  const [added, setAdded] = createSignal<{ secret: string; note: string } | null>(null);
  const action = createAction();
  const submit = (e: SubmitEvent): void => {
    e.preventDefault();
    void action.run(async () => {
      const body = { channel: "webhook", url: url().trim() };
      setAdded(
        await api(orgUrl("/api/notify/targets", props.org), webhookAddedSchema, {
          method: "POST",
          body,
        }),
      );
      setUrl("");
      props.onAdded();
    });
  };
  return (
    <>
      <Show when={added()}>
        {(done) => (
          <SecretOnce secret={done().secret} note={done().note} onDone={() => setAdded(null)} />
        )}
      </Show>
      <form class="nf-form" onSubmit={submit}>
        <div class="nf-row nf-row-end">
          <Field label="Webhook URL">
            {(control) => (
              <input
                {...control()}
                type="url"
                value={url()}
                required
                maxLength={2000}
                placeholder="https://example.com/harness-hook"
                onInput={(e) => setUrl(e.currentTarget.value)}
              />
            )}
          </Field>
          <Button type="submit" disabled={action.busy()}>
            Add
          </Button>
        </div>
        <ErrorLine message={action.error()} />
      </form>
    </>
  );
}
