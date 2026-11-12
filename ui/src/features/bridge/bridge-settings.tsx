import { type ChannelView, channelListSchema } from "@shared/chat";
import { createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { ignored } from "../../auth/me";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { TableBox } from "../../ui/data-table";
import { Button, Field, Panel } from "../../ui/primitives";
import { FormError } from "../orgs/shared";
import { BridgeLinkCode } from "./link-code";

type Kind = "slack" | "telegram";

interface Link {
  id: string;
  channelId: string;
  kind: Kind;
  externalId: string;
}

const linksSchema: z.ZodType<Link[]> = z.array(
  z.object({
    id: z.string(),
    channelId: z.string(),
    kind: z.enum(["slack", "telegram"]),
    externalId: z.string(),
  }),
);

const KIND_LABELS: Record<Kind, string> = { slack: "Slack", telegram: "Telegram" };
const EXTERNAL_LABELS: Record<Kind, string> = {
  slack: "Slack channel id (starts with C)",
  telegram: "Telegram chat id",
};

function NewLink(props: { channels: ChannelView[]; onCreated: () => void }): JSX.Element {
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
          setExternalId("");
          props.onCreated();
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

export function BridgeSettings(props: { slug: string }): JSX.Element {
  const links = createLoad(
    () => `/api/bridge/links?org=${encodeURIComponent(props.slug)}`,
    linksSchema,
  );
  const names = createLoad(() => `/api/orgs/${props.slug}/channels`, channelListSchema);
  const action = createAction();
  const [removing, setRemoving] = createSignal<Link | null>(null);
  const nameOf = (id: string): string => names.data()?.find((c) => c.id === id)?.name ?? id;
  const remove = (link: Link): void => {
    void action.run(async () => {
      await api(`/api/bridge/links/${encodeURIComponent(link.id)}`, ignored, { method: "DELETE" });
      await links.reload();
    });
  };
  return (
    <Panel title="Slack and Telegram bridges">
      <div class="stack">
        <p class="muted">
          A bridged channel mirrors messages both ways. Tokens are set up on the instance, not here.
        </p>
        <FormError message={action.error() ?? links.error() ?? names.error()} />
        <Show
          when={(links.data()?.length ?? 0) > 0}
          fallback={
            <Show when={links.data()}>
              <p class="muted">No channel is bridged.</p>
            </Show>
          }
        >
          <TableBox label="Bridged channels">
            <thead>
              <tr>
                <th scope="col">Channel</th>
                <th scope="col">Service</th>
                <th scope="col">External id</th>
                <th scope="col">
                  <span class="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={links.data()}>
                {(l) => (
                  <tr>
                    <th scope="row">#{nameOf(l.channelId)}</th>
                    <td>{KIND_LABELS[l.kind]}</td>
                    <td class="mono">{l.externalId}</td>
                    <td>
                      <Button
                        size="sm"
                        tone="danger"
                        disabled={action.busy()}
                        aria-label={`Remove the ${KIND_LABELS[l.kind]} bridge of #${nameOf(l.channelId)}`}
                        onClick={() => setRemoving(l)}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </TableBox>
        </Show>
        <NewLink channels={names.data() ?? []} onCreated={() => void links.reload()} />
        <BridgeLinkCode kind="slack" org={props.slug} />
        <ConfirmDialog
          open={removing() !== null}
          title="Remove this bridge?"
          message={`Messages in #${nameOf(removing()?.channelId ?? "")} stop mirroring to ${removing() ? KIND_LABELS[removing()?.kind ?? "slack"] : ""}.`}
          confirm="Remove bridge"
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            const link = removing();
            setRemoving(null);
            if (link) remove(link);
          }}
        />
      </div>
    </Panel>
  );
}
