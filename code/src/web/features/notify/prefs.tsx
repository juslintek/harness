import { useEffect, useState } from "preact/hooks";
import { CHANNELS, type PrefView } from "../../../shared/notify";
import { api, useLoad } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { useAction } from "../auth/use-action";
import { prefsSchema } from "./notify-data";
import { CHANNEL_LABELS, gridRows, KIND_LABELS, withPref } from "./notify-logic";

export function PrefsGrid({ org }: { org: string }): preact.JSX.Element {
  const url = `/api/notify/prefs?org=${encodeURIComponent(org)}`;
  const loaded = useLoad(() => api(url, prefsSchema), [org]);
  const [prefs, setPrefs] = useState<PrefView[]>([]);
  const action = useAction();
  useEffect(() => {
    if (loaded.data) setPrefs(loaded.data);
  }, [loaded.data]);
  const toggle = (next: PrefView): Promise<void> =>
    action.run(async () => {
      try {
        setPrefs(await api(url, prefsSchema, { method: "PUT", body: next }));
      } catch (err) {
        setPrefs((cur) => withPref(cur, { ...next, enabled: !next.enabled }));
        throw err;
      }
    });
  return (
    <section aria-labelledby="prefs-h">
      <h3 id="prefs-h">Notifications</h3>
      <p class="muted">Choose where each kind of event reaches you.</p>
      <ErrorLine message={action.error ?? loaded.error} />
      <div class="grid-scroll">
        <table class="prefs-grid">
          <caption class="sr-only">Notification kinds by channel</caption>
          <thead>
            <tr>
              <th scope="col">Event</th>
              {CHANNELS.map((c) => (
                <th key={c} scope="col">
                  {CHANNEL_LABELS[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {gridRows(prefs).map((row) => (
              <tr key={row.kind}>
                <th scope="row">{KIND_LABELS[row.kind]}</th>
                {row.cells.map((cell) => (
                  <td key={cell.channel}>
                    <input
                      type="checkbox"
                      checked={cell.enabled}
                      disabled={!loaded.data}
                      aria-label={`${KIND_LABELS[row.kind]} by ${CHANNEL_LABELS[cell.channel]}`}
                      onChange={(e) => {
                        const enabled = e.currentTarget.checked;
                        const next = { channel: cell.channel, kind: row.kind, enabled };
                        setPrefs((cur) => withPref(cur, next));
                        toggle(next).catch((err: unknown) => console.error(err));
                      }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
