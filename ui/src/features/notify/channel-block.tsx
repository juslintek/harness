import type { Channel, TargetView } from "@shared/notify";
import { For, type JSX, Show } from "solid-js";
import { TelegramLinkCode } from "./link-code";
import { CHANNEL_LABELS } from "./logic";
import "./notify.css";
import { Help } from "../../ui/atoms";
import { PushSubscribe } from "./push";
import { ValueForm, WebhookForm } from "./target-forms";
import { TargetRow } from "./target-row";

function AddForm(props: { channel: Channel; org: string; onAdded: () => void }): JSX.Element {
  const c = props.channel;
  if (c === "push") return <PushSubscribe org={props.org} onChange={props.onAdded} />;
  if (c === "telegram") return <TelegramLinkCode org={props.org} onLinked={props.onAdded} />;
  if (c === "webhook") return <WebhookForm org={props.org} onAdded={props.onAdded} />;
  if (c === "email") {
    return (
      <ValueForm
        channel="email"
        org={props.org}
        field="address"
        label="Email address"
        hint={
          <>
            Email is sent through the SMTP settings. Check them under{" "}
            <a href="#/integrations">Integrations</a>.
          </>
        }
        onAdded={props.onAdded}
      />
    );
  }
  return (
    <ValueForm
      channel="slack"
      org={props.org}
      field="userId"
      label="Slack user id"
      hint="The member id from your Slack profile (it starts with U). The bot sends you a direct message."
      onAdded={props.onAdded}
    />
  );
}

const NEXT: Record<Channel, string> = {
  push: "enable it on a browser",
  email: "add one",
  slack: "add one",
  telegram: "link a chat",
  webhook: "add one",
};

export function ChannelBlock(props: {
  channel: Channel;
  org: string;
  items: TargetView[];
  busy: boolean;
  onRemove: (t: TargetView) => void;
  onAdded: () => void;
}): JSX.Element {
  const label = CHANNEL_LABELS[props.channel];
  const name =
    props.channel === "slack" || props.channel === "telegram" ? label : label.toLowerCase();
  return (
    <section class="nf-channel" id={`target-${props.channel}`} aria-label={label}>
      <h3 class="nf-channel-title">{label}</h3>
      <Show
        when={props.items.length > 0}
        fallback={
          <Help small>
            No {name} target yet. Notifications cannot reach {name} until you {NEXT[props.channel]}.
          </Help>
        }
      >
        <ul class="nf-list">
          <For each={props.items}>
            {(t) => (
              <TargetRow target={t} channel={label} busy={props.busy} onRemove={props.onRemove} />
            )}
          </For>
        </ul>
      </Show>
      <AddForm channel={props.channel} org={props.org} onAdded={props.onAdded} />
    </section>
  );
}
