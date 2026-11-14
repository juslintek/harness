import { channelListSchema } from "@shared/chat";
import { createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ignored } from "../../auth/me";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { Help } from "../../ui/atoms";
import { Notice, Panel, Steps, TableBox } from "../../ui/molecules";
import { FormError } from "../orgs/shared";
import { type Link, linksSchema } from "./bridge-data";
import { BridgeRow } from "./bridge-row";
import { BridgeLinkCode } from "./link-code";
import { NewLink } from "./new-link";

export function BridgeSettings(props: { slug: string }): JSX.Element {
  const links = createLoad(
    () => `/api/bridge/links?org=${encodeURIComponent(props.slug)}`,
    linksSchema,
  );
  const names = createLoad(() => `/api/orgs/${props.slug}/channels`, channelListSchema);
  const action = createAction();
  const [done, setDone] = createSignal<string | null>(null);
  const [issued, setIssued] = createSignal(false);
  const nameOf = (id: string): string => names.data()?.find((c) => c.id === id)?.name ?? id;
  const bridged = (): boolean => (links.data()?.length ?? 0) > 0;
  const remove = (link: Link, channel: string): void => {
    setDone(null);
    void action.run(async () => {
      await api(`/api/bridge/links/${encodeURIComponent(link.id)}`, ignored, { method: "DELETE" });
      await links.reload();
      setDone(`Removed the bridge of #${channel}.`);
    });
  };
  return (
    <Panel title="Slack and Telegram bridges">
      <div class="stack">
        <Help>
          A bridged channel mirrors messages both ways. Tokens are set up on the instance, not here.
          Messages from people who have not linked their account are dropped.
        </Help>
        <FormError message={action.error() ?? links.error() ?? names.error()} />
        <Show when={done()}>{(text) => <Notice tone="success">{text()}</Notice>}</Show>
        <Show
          when={bridged()}
          fallback={
            <Show when={links.data()}>
              <p class="muted">No channel is bridged.</p>
            </Show>
          }
        >
          <TableBox stack label="Bridged channels">
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
                  <BridgeRow
                    link={l}
                    channel={nameOf(l.channelId)}
                    busy={action.busy()}
                    onRemove={() => remove(l, nameOf(l.channelId))}
                  />
                )}
              </For>
            </tbody>
          </TableBox>
        </Show>
        <NewLink
          channels={names.data() ?? []}
          onCreated={(text) => {
            setDone(text);
            void links.reload();
          }}
        />
        <h3 class="sub-title bridge-link-title">Link your own account</h3>
        <Steps
          label="Bridge setup"
          items={[
            { label: "Bridge a channel", state: bridged() ? "done" : "current" },
            {
              label: "Get your link code",
              state: issued() ? "done" : bridged() ? "current" : "todo",
            },
            { label: "Send /link CODE in a private message", state: issued() ? "current" : "todo" },
          ]}
        />
        <BridgeLinkCode kind="slack" org={props.slug} onIssued={() => setIssued(true)} />
        <Help small>Telegram link codes are under Account, in Where notifications go.</Help>
      </div>
    </Panel>
  );
}
