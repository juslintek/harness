import { CHANNELS, type Channel, type PrefView, type TargetView } from "@shared/notify";
import { createEffect, createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { Button, Help } from "../../ui/atoms";
import { Notice, Panel, TableBox } from "../../ui/molecules";
import { prefsSchema } from "./data";
import { CHANNEL_LABELS, gridRows, KIND_LABELS, withPref } from "./logic";
import "./notify.css";

const SET_TARGET: Record<Channel, string> = {
  push: "Turn on push",
  email: "Add an email address",
  slack: "Set a Slack user id",
  telegram: "Link Telegram",
  webhook: "Add a webhook",
};

const showTarget = (channel: Channel): void => {
  const section = document.getElementById(`target-${channel}`);
  section?.scrollIntoView({ block: "center" });
  section?.querySelector<HTMLElement>("input, button")?.focus();
};

const list = (words: string[]): string =>
  words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

export function PrefsGrid(props: {
  org: string;
  targets: TargetView[] | undefined;
  picker?: JSX.Element;
}): JSX.Element {
  // Until the targets arrive nothing is known, so nothing is claimed to be missing.
  const missing = (): Channel[] =>
    props.targets ? CHANNELS.filter((c) => !props.targets?.some((t) => t.channel === c)) : [];
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
      <Help small>
        Choose where each kind of event reaches you. A channel only works when it has a target under
        Where notifications go.
      </Help>

      <Show when={missing().length > 0}>
        <Notice
          tone="warning"
          title={`${list(missing().map((c) => CHANNEL_LABELS[c]))} ${missing().length === 1 ? "has" : "have"} no target`}
        >
          Nothing is sent there until you add one, so those boxes are off.
          <div class="nf-row">
            <For each={missing()}>
              {(c) => (
                <Button size="sm" onClick={() => showTarget(c)}>
                  {SET_TARGET[c]}
                </Button>
              )}
            </For>
          </div>
        </Notice>
      </Show>
      {props.picker}
      <ErrorLine message={action.error() ?? loaded.error()} />

      <TableBox stack label="Notification kinds by channel">
        <caption class="sr-only">Notification kinds by channel</caption>
        <thead>
          <tr>
            <th scope="col">Event</th>
            <For each={CHANNELS}>
              {(c) => (
                <th scope="col">
                  {CHANNEL_LABELS[c]}
                  <Show when={missing().includes(c)}>
                    <small class="nf-no-target">no target</small>
                  </Show>
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={gridRows(prefs())}>
            {(row) => (
              <tr>
                <th scope="row">{KIND_LABELS[row.kind]}</th>
                <For each={row.cells}>
                  {(cell) => (
                    <td
                      data-label={`${CHANNEL_LABELS[cell.channel]}${missing().includes(cell.channel) ? " (no target)" : ""}`}
                    >
                      <input
                        type="checkbox"
                        class="pref-check"
                        checked={cell.enabled && !missing().includes(cell.channel)}
                        disabled={
                          !loaded.data() || !props.targets || missing().includes(cell.channel)
                        }
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
