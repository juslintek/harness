import { For, type JSX } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { ignored, setMe } from "../../auth/me";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { Button, Panel } from "../../ui/primitives";
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
  const revoke = (id: string): void => {
    void action.run(async () => {
      await api(`/api/auth/sessions/${encodeURIComponent(id)}`, ignored, { method: "DELETE" });
      await sessions.reload();
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
      <ErrorLine message={action.error() ?? sessions.error()} />
      <ul class="acct-list">
        <For each={sessions.data()}>
          {(s) => (
            <li class="acct-item">
              <span class="acct-text">
                <strong>{s.current ? "This device" : (s.userAgent ?? "Unknown device")}</strong>
                <span class="acct-meta">
                  signed in by {s.method} {fmtTime(s.createdAt)}, last seen {fmtTime(s.lastSeenAt)}
                </span>
              </span>
              {s.current ? (
                <Button size="sm" disabled={action.busy()} onClick={signOut}>
                  Sign out
                </Button>
              ) : (
                <Button
                  size="sm"
                  tone="danger"
                  disabled={action.busy()}
                  aria-label={`Revoke session ${s.userAgent ?? s.id}`}
                  onClick={() => revoke(s.id)}
                >
                  Revoke
                </Button>
              )}
            </li>
          )}
        </For>
      </ul>
    </Panel>
  );
}
