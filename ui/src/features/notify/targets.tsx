import { CHANNELS, type Channel, type TargetView } from "@shared/notify";
import { For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { ignored } from "../../auth/me";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { Button, Panel } from "../../ui/primitives";
import { orgUrl, targetsSchema } from "./data";
import { TelegramLinkCode } from "./link-code";
import { CHANNEL_LABELS } from "./logic";
import "./notify.css";
import { PushSubscribe } from "./push";
import { ValueForm, WebhookForm } from "./target-forms";

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
        hint="Needs SMTP to be set up on the integrations page."
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

function ChannelBlock(props: {
  channel: Channel;
  org: string;
  items: TargetView[];
  busy: boolean;
  onRemove: (t: TargetView) => void;
  onAdded: () => void;
}): JSX.Element {
  const label = CHANNEL_LABELS[props.channel];
  return (
    <section class="nf-channel" aria-label={label}>
      <h3 class="nf-channel-title">{label}</h3>
      <Show
        when={props.items.length > 0}
        fallback={<p class="nf-hint">No {label.toLowerCase()} target yet.</p>}
      >
        <ul class="nf-list">
          <For each={props.items}>
            {(t) => (
              <li class="nf-item">
                <span class="nf-item-label">{t.label}</span>
                <Button
                  size="sm"
                  tone="danger"
                  disabled={props.busy}
                  aria-label={`Remove ${label} target ${t.label}`}
                  onClick={() => props.onRemove(t)}
                >
                  Remove
                </Button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <AddForm channel={props.channel} org={props.org} onAdded={props.onAdded} />
    </section>
  );
}

export function Targets(props: { org: string }): JSX.Element {
  const targets = createLoad(orgUrl("/api/notify/targets", props.org), targetsSchema);
  const action = createAction();
  const remove = (t: TargetView): void => {
    void action.run(async () => {
      await api(orgUrl(`/api/notify/targets/${encodeURIComponent(t.id)}`, props.org), ignored, {
        method: "DELETE",
      });
      await targets.reload();
    });
  };
  return (
    <Panel title="Where notifications go">
      <ErrorLine message={action.error() ?? targets.error()} />
      <For each={CHANNELS}>
        {(channel) => (
          <ChannelBlock
            channel={channel}
            org={props.org}
            items={targets.data()?.filter((t) => t.channel === channel) ?? []}
            busy={action.busy()}
            onRemove={remove}
            onAdded={() => void targets.reload()}
          />
        )}
      </For>
    </Panel>
  );
}
