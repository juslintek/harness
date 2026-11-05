import { CHANNELS, type Channel, type TargetView } from "../../../shared/notify";
import { api, useLoad } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { ignored } from "../auth/me";
import { useAction } from "../auth/use-action";
import { targetsSchema } from "./notify-data";
import { CHANNEL_LABELS } from "./notify-logic";
import { PushSubscribe } from "./push-subscribe";
import { TelegramLink, ValueForm, WebhookForm } from "./target-forms";

function AddForm({
  channel,
  onAdded,
}: {
  channel: Channel;
  onAdded: () => void;
}): preact.JSX.Element {
  if (channel === "push") return <PushSubscribe onChange={onAdded} />;
  if (channel === "telegram") return <TelegramLink onLinked={onAdded} />;
  if (channel === "webhook") return <WebhookForm onAdded={onAdded} />;
  if (channel === "email") {
    return (
      <ValueForm
        channel="email"
        field="address"
        label="Email address"
        hint="Needs SMTP to be set up on the integrations page."
        onAdded={onAdded}
      />
    );
  }
  return (
    <ValueForm
      channel="slack"
      field="userId"
      label="Slack user id"
      hint="The member id from your Slack profile (it starts with U). The bot sends you a direct message."
      onAdded={onAdded}
    />
  );
}

function ChannelBlock({
  channel,
  items,
  busy,
  onRemove,
  onAdded,
}: {
  channel: Channel;
  items: TargetView[];
  busy: boolean;
  onRemove: (t: TargetView) => void;
  onAdded: () => void;
}): preact.JSX.Element {
  const headingId = `targets-${channel}`;
  return (
    <section class="card" aria-labelledby={headingId}>
      <h4 id={headingId}>{CHANNEL_LABELS[channel]}</h4>
      {items.length === 0 ? (
        <p class="muted">No {CHANNEL_LABELS[channel].toLowerCase()} target yet.</p>
      ) : (
        <ul class="plain">
          {items.map((t) => (
            <li key={t.id} class="row target-row">
              <span class="target-label">{t.label}</span>
              <button
                type="button"
                class="danger"
                disabled={busy}
                aria-label={`Remove ${CHANNEL_LABELS[channel]} target ${t.label}`}
                onClick={() => onRemove(t)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <AddForm channel={channel} onAdded={onAdded} />
    </section>
  );
}

export function Targets(): preact.JSX.Element {
  const targets = useLoad(() => api("/api/notify/targets", targetsSchema), []);
  const action = useAction();
  const remove = (t: TargetView): Promise<void> =>
    action.run(async () => {
      await api(`/api/notify/targets/${encodeURIComponent(t.id)}`, ignored, { method: "DELETE" });
      targets.reload();
    });
  return (
    <section aria-labelledby="targets-h">
      <h3 id="targets-h">Where notifications go</h3>
      <ErrorLine message={action.error ?? targets.error} />
      {CHANNELS.map((channel) => (
        <ChannelBlock
          key={channel}
          channel={channel}
          items={targets.data?.filter((t) => t.channel === channel) ?? []}
          busy={action.busy}
          onRemove={(t) => {
            remove(t).catch((err: unknown) => console.error(err));
          }}
          onAdded={targets.reload}
        />
      ))}
    </section>
  );
}
