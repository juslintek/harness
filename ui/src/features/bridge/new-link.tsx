import type { ChannelView } from "@shared/chat";
import { createSignal, For, type JSX } from "solid-js";
import { api } from "../../api";
import { ignored } from "../../auth/me";
import { createAction } from "../../ui/action";
import { Button } from "../../ui/atoms";
import { Field } from "../../ui/molecules";
import { EXTERNAL_LABELS, KIND_LABELS, type Kind } from "./bridge-data";

export function NewLink(props: {
  channels: ChannelView[];
  onCreated: (text: string) => void;
}): JSX.Element {
  const [channelId, setChannelId] = createSignal("");
  const [kind, setKind] = createSignal<Kind>("slack");
  const [externalId, setExternalId] = createSignal("");
  const action = createAction();
  const bridgeable = (): ChannelView[] =>
    props.channels.filter((c) => c.kind !== "dm" && c.kind !== "group");
  return (
    <form
      class="form-row"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          const body = { channelId: channelId(), kind: kind(), externalId: externalId().trim() };
          await api("/api/bridge/links", ignored, { method: "POST", body });
          const channel = props.channels.find((ch) => ch.id === channelId());
          setExternalId("");
          props.onCreated(`Bridged #${channel?.name ?? "the channel"} to ${KIND_LABELS[kind()]}.`);
        });
      }}
    >
      <Field label="Harness channel">
        {(c) => (
          <select {...c()} required onChange={(e) => setChannelId(e.currentTarget.value)}>
            <option value="">Choose…</option>
            <For each={bridgeable()}>{(ch) => <option value={ch.id}>#{ch.name}</option>}</For>
          </select>
        )}
      </Field>
      <Field label="Service">
        {(c) => (
          <select {...c()} onChange={(e) => setKind(e.currentTarget.value as Kind)}>
            <option value="slack">Slack</option>
            <option value="telegram">Telegram</option>
          </select>
        )}
      </Field>
      <Field label={EXTERNAL_LABELS[kind()]} error={action.error()}>
        {(c) => (
          <input
            {...c()}
            value={externalId()}
            required
            maxLength={64}
            onInput={(e) => setExternalId(e.currentTarget.value)}
          />
        )}
      </Field>
      <Button type="submit" disabled={action.busy()}>
        Bridge channel
      </Button>
    </form>
  );
}
