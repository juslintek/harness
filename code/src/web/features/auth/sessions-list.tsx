import { z } from "zod";
import { api, useLoad } from "../../api";
import { fmtTime } from "../../format";
import { ErrorLine } from "./error-line";
import { ignored, me } from "./me";
import { useAction } from "./use-action";

interface SessionRow {
  id: string;
  method: string;
  userAgent: string | null;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
}
const listSchema: z.ZodType<SessionRow[]> = z.array(
  z.object({
    id: z.string(),
    method: z.string(),
    userAgent: z.string().nullable(),
    createdAt: z.number(),
    lastSeenAt: z.number(),
    current: z.boolean(),
  }),
);

export function SessionsList(): preact.JSX.Element {
  const sessions = useLoad(() => api("/api/auth/sessions", listSchema), []);
  const action = useAction();
  const revoke = (id: string): Promise<void> =>
    action.run(async () => {
      await api(`/api/auth/sessions/${encodeURIComponent(id)}`, ignored, { method: "DELETE" });
      sessions.reload();
    });
  const signOut = (): Promise<void> =>
    action.run(async () => {
      await api("/api/auth/logout", ignored, { method: "POST", body: {} });
      me.value = null;
      location.hash = "#/login";
    });
  return (
    <section aria-labelledby="sessions-h">
      <h3 id="sessions-h">Sessions</h3>
      <ErrorLine message={action.error ?? sessions.error} />
      <ul class="plain">
        {sessions.data?.map((s) => (
          <li key={s.id} class="card row">
            <span>
              <strong>{s.current ? "This device" : (s.userAgent ?? "Unknown device")}</strong>
              <span class="muted">
                {" "}
                signed in by {s.method} {fmtTime(s.createdAt)}, last seen {fmtTime(s.lastSeenAt)}
              </span>
            </span>
            {s.current ? (
              <button type="button" disabled={action.busy} onClick={signOut}>
                Sign out
              </button>
            ) : (
              <button
                type="button"
                class="danger"
                disabled={action.busy}
                onClick={() => revoke(s.id)}
                aria-label={`Revoke session ${s.userAgent ?? s.id}`}
              >
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
