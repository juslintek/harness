import { useState } from "preact/hooks";
import { z } from "zod";
import { api, useLoad } from "../../api";
import { fmtTime } from "../../format";
import { ErrorLine } from "./error-line";
import { ignored } from "./me";
import { useAction } from "./use-action";
import { creationChallengeSchema, register } from "./webauthn";

interface Passkey {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}
const listSchema: z.ZodType<Passkey[]> = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    createdAt: z.number(),
    lastUsedAt: z.number().nullable(),
  }),
);

export function PasskeysList(): preact.JSX.Element {
  const passkeys = useLoad(() => api("/api/auth/passkeys", listSchema), []);
  const action = useAction();
  const [name, setName] = useState("");
  const add = (e: Event): Promise<void> => {
    e.preventDefault();
    return action.run(async () => {
      const options = await api("/api/auth/passkeys/options", creationChallengeSchema, {
        method: "POST",
        body: {},
      });
      const response = await register(options);
      await api("/api/auth/passkeys/verify", ignored, {
        method: "POST",
        body: { challengeId: options.challengeId, response, name: name.trim() || "Passkey" },
      });
      setName("");
      passkeys.reload();
    });
  };
  const remove = (id: string): Promise<void> =>
    action.run(async () => {
      await api(`/api/auth/passkeys/${encodeURIComponent(id)}`, ignored, { method: "DELETE" });
      passkeys.reload();
    });
  return (
    <section aria-labelledby="passkeys-h">
      <h3 id="passkeys-h">Passkeys</h3>
      <ErrorLine message={action.error ?? passkeys.error} />
      <ul class="plain">
        {passkeys.data?.map((p) => (
          <li key={p.id} class="card row">
            <span>
              <strong>{p.name}</strong>
              <span class="muted">
                {" "}
                added {fmtTime(p.createdAt)}, last used {fmtTime(p.lastUsedAt)}
              </span>
            </span>
            <button
              type="button"
              class="danger"
              disabled={action.busy}
              onClick={() => remove(p.id)}
              aria-label={`Remove passkey ${p.name}`}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={add}>
        <label>
          Name for the new passkey
          <input
            value={name}
            maxLength={80}
            placeholder="Laptop"
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </label>
        <button type="submit" disabled={action.busy}>
          Add a passkey
        </button>
      </form>
    </section>
  );
}
