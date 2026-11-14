import { CHANNELS, type TargetView } from "@shared/notify";
import { createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { ignored } from "../../auth/me";
import { createAction } from "../../ui/action";
import { Notice, Panel } from "../../ui/molecules";
import { ChannelBlock } from "./channel-block";
import { orgUrl } from "./data";
import "./notify.css";

export function Targets(props: {
  org: string;
  targets: TargetView[] | undefined;
  error: string | null;
  onChange: () => Promise<void>;
}): JSX.Element {
  const action = createAction();
  const [done, setDone] = createSignal<string | null>(null);
  const remove = (t: TargetView): void => {
    setDone(null);
    void action.run(async () => {
      await api(orgUrl(`/api/notify/targets/${encodeURIComponent(t.id)}`, props.org), ignored, {
        method: "DELETE",
      });
      await props.onChange();
      setDone(`Removed ${t.label}.`);
    });
  };
  return (
    <Panel title="Where notifications go">
      <ErrorLine message={action.error() ?? props.error} />
      <Show when={done()}>{(text) => <Notice tone="success">{text()}</Notice>}</Show>
      <For each={CHANNELS}>
        {(channel) => (
          <ChannelBlock
            channel={channel}
            org={props.org}
            items={props.targets?.filter((t) => t.channel === channel) ?? []}
            busy={action.busy()}
            onRemove={remove}
            onAdded={() => void props.onChange()}
          />
        )}
      </For>
    </Panel>
  );
}
