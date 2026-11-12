import { CHANNELS, type PrefView } from "@shared/notify";
import { createEffect, createSignal, For, type JSX } from "solid-js";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { TableBox } from "../../ui/data-table";
import { Panel } from "../../ui/primitives";
import { prefsSchema } from "./data";
import { CHANNEL_LABELS, gridRows, KIND_LABELS, withPref } from "./logic";
import "./notify.css";

export function PrefsGrid(props: { org: string }): JSX.Element {
  const url = `/api/notify/prefs?org=${encodeURIComponent(props.org)}`;
  const loaded = createLoad(url, prefsSchema);
  const [prefs, setPrefs] = createSignal<PrefView[]>([]);
  const action = createAction();
  createEffect(() => {
    const data = loaded.data();
    if (data) setPrefs(data);
  });
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
    <Panel title="Notifications">
      <p class="nf-hint">Choose where each kind of event reaches you.</p>
      <ErrorLine message={action.error() ?? loaded.error()} />
      <TableBox label="Notification kinds by channel">
        <caption class="sr-only">Notification kinds by channel</caption>
        <thead>
          <tr>
            <th scope="col">Event</th>
            <For each={CHANNELS}>{(c) => <th scope="col">{CHANNEL_LABELS[c]}</th>}</For>
          </tr>
        </thead>
        <tbody>
          <For each={gridRows(prefs())}>
            {(row) => (
              <tr>
                <th scope="row">{KIND_LABELS[row.kind]}</th>
                <For each={row.cells}>
                  {(cell) => (
                    <td>
                      <input
                        type="checkbox"
                        class="pref-check"
                        checked={cell.enabled}
                        disabled={!loaded.data()}
                        aria-label={`${KIND_LABELS[row.kind]} by ${CHANNEL_LABELS[cell.channel]}`}
                        onChange={(e) => {
                          const next = {
                            channel: cell.channel,
                            kind: row.kind,
                            enabled: e.currentTarget.checked,
                          };
                          setPrefs((cur) => withPref(cur, next));
                          void toggle(next);
                        }}
                      />
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </TableBox>
    </Panel>
  );
}
