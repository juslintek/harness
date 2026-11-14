import { createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { ignored } from "../../auth/me";
import { creationChallengeSchema, register } from "../../auth/webauthn";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { Button, Help } from "../../ui/atoms";
import { ConfirmButton, Field, Notice, Panel } from "../../ui/molecules";
import { AcctItem } from "./acct-item";
import "./account.css";
import { fmtTime } from "./time";

const listSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    createdAt: z.number(),
    lastUsedAt: z.number().nullable(),
  }),
);

export function PasskeysList(): JSX.Element {
  const passkeys = createLoad("/api/auth/passkeys", listSchema);
  const action = createAction();
  const [name, setName] = createSignal("");
  const [done, setDone] = createSignal<string | null>(null);
  const last = (): boolean => (passkeys.data()?.length ?? 0) <= 1;
  const add = (e: SubmitEvent): void => {
    e.preventDefault();
    setDone(null);
    void action.run(async () => {
      const options = await api("/api/auth/passkeys/options", creationChallengeSchema, {
        method: "POST",
        body: {},
      });
      const response = await register(options);
      await api("/api/auth/passkeys/verify", ignored, {
        method: "POST",
        body: { challengeId: options.challengeId, response, name: name().trim() || "Passkey" },
      });
      setDone(`Added passkey ${name().trim() || "Passkey"}.`);
      setName("");
      await passkeys.reload();
    });
  };
  const remove = (id: string, label: string): void => {
    setDone(null);
    void action.run(async () => {
      await api(`/api/auth/passkeys/${encodeURIComponent(id)}`, ignored, { method: "DELETE" });
      await passkeys.reload();
      setDone(`Removed passkey ${label}.`);
    });
  };
  return (
    <Panel title="Passkeys">
      <Help small>
        A passkey signs you in and approves sensitive actions. Keep at least two. The last passkey
        cannot be removed.
      </Help>
      <ErrorLine message={action.error() ?? passkeys.error()} />
      <Show when={done()}>{(text) => <Notice tone="success">{text()}</Notice>}</Show>
      <ul class="acct-list">
        <For each={passkeys.data()}>
          {(p) => (
            <AcctItem
              title={<strong>{p.name}</strong>}
              meta={`added ${fmtTime(p.createdAt)} · ${p.lastUsedAt === null ? "never used" : `last used ${fmtTime(p.lastUsedAt)}`}`}
              action={
                <ConfirmButton
                  size="sm"
                  text="Remove"
                  confirm="Remove"
                  label={`Remove passkey ${p.name}`}
                  title={`Remove passkey ${p.name}?`}
                  message="This passkey can no longer sign you in. Your other passkeys keep working."
                  disabled={action.busy() || last()}
                  onConfirm={() => remove(p.id, p.name)}
                />
              }
            />
          )}
        </For>
      </ul>
      <form class="acct-add" onSubmit={add}>
        <Field label="Name for the new passkey">
          {(control) => (
            <input
              {...control()}
              value={name()}
              maxLength={80}
              placeholder="Laptop"
              onInput={(e) => setName(e.currentTarget.value)}
            />
          )}
        </Field>
        <Button type="submit" disabled={action.busy()}>
          Add a passkey
        </Button>
      </form>
    </Panel>
  );
}
