import { createSignal, For, type JSX } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { ignored } from "../../auth/me";
import { creationChallengeSchema, register } from "../../auth/webauthn";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { Button, Field, Panel } from "../../ui/primitives";
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
  const add = (e: SubmitEvent): void => {
    e.preventDefault();
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
      setName("");
      await passkeys.reload();
    });
  };
  const remove = (id: string): void => {
    void action.run(async () => {
      await api(`/api/auth/passkeys/${encodeURIComponent(id)}`, ignored, { method: "DELETE" });
      await passkeys.reload();
    });
  };
  return (
    <Panel title="Passkeys">
      <ErrorLine message={action.error() ?? passkeys.error()} />
      <ul class="acct-list">
        <For each={passkeys.data()}>
          {(p) => (
            <li class="acct-item">
              <span class="acct-text">
                <strong>{p.name}</strong>
                <span class="acct-meta">
                  added {fmtTime(p.createdAt)}, last used {fmtTime(p.lastUsedAt)}
                </span>
              </span>
              <Button
                size="sm"
                tone="danger"
                disabled={action.busy()}
                aria-label={`Remove passkey ${p.name}`}
                onClick={() => remove(p.id)}
              >
                Remove
              </Button>
            </li>
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
