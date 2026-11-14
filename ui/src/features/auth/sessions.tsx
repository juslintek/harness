import { createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { ignored, setMe } from "../../auth/me";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { Button, Help } from "../../ui/atoms";
import { ConfirmButton, Notice, Panel } from "../../ui/molecules";
import { AcctItem } from "./acct-item";
import "./account.css";
import { fmtTime } from "./time";

const listSchema = z.array(
  z.object({
    id: z.string(),
    method: z.string(),
    userAgent: z.string().nullable(),
    createdAt: z.number(),
    lastSeenAt: z.number(),
    current: z.boolean(),
  }),
);

export function SessionsList(): JSX.Element {
  const sessions = createLoad("/api/auth/sessions", listSchema);
  const action = createAction();
  const [done, setDone] = createSignal<string | null>(null);
  const revoke = (id: string, device: string): void => {
    setDone(null);
    void action.run(async () => {
      await api(`/api/auth/sessions/${encodeURIComponent(id)}`, ignored, { method: "DELETE" });
      await sessions.reload();
      setDone(`Revoked the session on ${device}.`);
    });
  };
  const signOut = (): void => {
    void action.run(async () => {
      await api("/api/auth/logout", ignored, { method: "POST", body: {} });
      setMe(null);
      location.hash = "#/login";
    });
  };
  return (
    <Panel title="Sessions">
      <Help small>
        Each browser you are signed in on. Revoking another session signs it out at once and asks
        for your passkey.
      </Help>
      <ErrorLine message={action.error() ?? sessions.error()} />
      <Show when={done()}>{(text) => <Notice tone="success">{text()}</Notice>}</Show>
      <ul class="acct-list">
        <For each={sessions.data()}>
          {(s) => (
            <AcctItem
              title={
                <strong>{s.current ? "This device" : (s.userAgent ?? "Unknown device")}</strong>
              }
              meta={`signed in by ${s.method} ${fmtTime(s.createdAt)} · last seen ${fmtTime(s.lastSeenAt)}`}
              action={
                s.current ? (
                  <Button size="sm" disabled={action.busy()} onClick={signOut}>
                    Sign out
                  </Button>
                ) : (
                  <ConfirmButton
                    size="sm"
                    text="Revoke"
                    confirm="Revoke"
                    label={`Revoke session ${s.userAgent ?? s.id}`}
                    title={`Revoke the session on ${s.userAgent ?? "this device"}?`}
                    message="That device is signed out at once and has to sign in again."
                    disabled={action.busy()}
                    onConfirm={() => revoke(s.id, s.userAgent ?? "that device")}
                  />
                )
              }
            />
          )}
        </For>
      </ul>
    </Panel>
  );
}
