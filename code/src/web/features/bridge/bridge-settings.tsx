import { useState } from "preact/hooks";
import { z } from "zod";
import { type ChannelView, channelListSchema } from "../../../shared/chat";
import { api, useLoad } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { ignored } from "../auth/me";
import { useAction } from "../auth/use-action";

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

function LinkOwnSlack({ slug }: { slug: string }): preact.JSX.Element {
  const [userId, setUserId] = useState("");
  const [done, setDone] = useState(false);
  const action = useAction();
  const submit = (e: Event): void => {
    e.preventDefault();
    action
      .run(async () => {
        const body = { kind: "slack", externalUserId: userId.trim(), org: slug };
        await api("/api/bridge/users", ignored, { method: "POST", body });
        setDone(true);
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <form class="row" onSubmit={submit}>
      <label>
        Your Slack user id
        <input
          value={userId}
          required
          maxLength={64}
          onInput={(e) => {
            setUserId(e.currentTarget.value);
            setDone(false);
          }}
        />
      </label>
      <button type="submit" disabled={action.busy}>
        Link my Slack user
      </button>
      <p class="muted hint" role="status">
        {done
          ? "Linked. Messages you write in a bridged Slack channel are posted as you."
          : "Messages from a Slack user that is not linked to a member are ignored."}
      </p>
      <ErrorLine message={action.error} />
    </form>
  );
}

function NewLink({
  channels,
  onCreated,
}: {
  channels: ChannelView[];
  onCreated: () => void;
}): preact.JSX.Element {
  const [channelId, setChannelId] = useState("");
  const [kind, setKind] = useState<Kind>("slack");
  const [externalId, setExternalId] = useState("");
  const action = useAction();
  const bridgeable = channels.filter((c) => c.kind !== "dm" && c.kind !== "group");
  const submit = (e: Event): void => {
    e.preventDefault();
    action
      .run(async () => {
        const body = { channelId, kind, externalId: externalId.trim() };
        await api("/api/bridge/links", ignored, { method: "POST", body });
        setExternalId("");
        onCreated();
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <form class="row" onSubmit={submit}>
      <label>
        Harness channel
        <select value={channelId} required onChange={(e) => setChannelId(e.currentTarget.value)}>
          <option value="">Choose…</option>
          {bridgeable.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Service
        <select value={kind} onChange={(e) => setKind(e.currentTarget.value as Kind)}>
          <option value="slack">Slack</option>
          <option value="telegram">Telegram</option>
        </select>
      </label>
      <label>
        {EXTERNAL_LABELS[kind]}
        <input
          value={externalId}
          required
          maxLength={64}
          onInput={(e) => setExternalId(e.currentTarget.value)}
        />
      </label>
      <button type="submit" disabled={action.busy}>
        Bridge channel
      </button>
      <ErrorLine message={action.error} />
    </form>
  );
}

export function BridgeSettings({ slug }: { slug: string }): preact.JSX.Element {
  const links = useLoad(
    () => api(`/api/bridge/links?org=${encodeURIComponent(slug)}`, linksSchema),
    [slug],
  );
  const names = useLoad(() => api(`/api/orgs/${slug}/channels`, channelListSchema), [slug]);
  const action = useAction();
  const nameOf = (id: string): string => names.data?.find((c) => c.id === id)?.name ?? id;
  const remove = (link: Link): void => {
    action
      .run(async () => {
        await api(`/api/bridge/links/${encodeURIComponent(link.id)}`, ignored, {
          method: "DELETE",
        });
        links.reload();
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <section aria-labelledby="bridges-h">
      <h3 id="bridges-h">Slack and Telegram bridges</h3>
      <p class="muted">
        A bridged channel mirrors messages both ways. Tokens are set up on the instance, not here.
      </p>
      <ErrorLine message={action.error ?? links.error ?? names.error} />
      {links.data?.length === 0 && <p class="muted">No channel is bridged.</p>}
      <ul class="plain">
        {links.data?.map((l) => (
          <li key={l.id} class="card row target-row">
            <span class="target-label">
              #{nameOf(l.channelId)} <span class="muted">is bridged to</span> {KIND_LABELS[l.kind]}{" "}
              <code>{l.externalId}</code>
            </span>
            <button
              type="button"
              class="danger"
              disabled={action.busy}
              aria-label={`Remove the ${KIND_LABELS[l.kind]} bridge of #${nameOf(l.channelId)}`}
              onClick={() => remove(l)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <NewLink channels={names.data ?? []} onCreated={links.reload} />
      <LinkOwnSlack slug={slug} />
    </section>
  );
}
