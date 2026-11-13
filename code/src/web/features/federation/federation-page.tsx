import { useState } from "preact/hooks";
import { z } from "zod";
import { orgDetailSchema } from "../../../shared/orgs";
import { api, useLoad } from "../../api";
import { CopyButton } from "../../copy-button";
import { fmtTime } from "../../format";
import { ErrorLine } from "../auth/error-line";
import { me } from "../auth/me";
import { useAction } from "../auth/use-action";
import {
  type Identity,
  type Invite,
  identitySchema,
  inviteSchema,
  type ProjectChoice,
  peersSchema,
  sharesSchema,
} from "./federation-data";
import { PeersCard } from "./peers-card";
import { SharesCard } from "./shares-card";

function IdentityCard({ identity }: { identity: Identity }): preact.JSX.Element {
  return (
    <section class="card" aria-labelledby="fed-id">
      <h3 id="fed-id">This instance</h3>
      <dl class="summary">
        <dt>Name</dt>
        <dd>{identity.name}</dd>
        <dt>Instance id</dt>
        <dd>
          <code>{identity.instanceId}</code>{" "}
          <CopyButton text={identity.instanceId} label="Copy instance id" />
        </dd>
        <dt>Key fingerprint</dt>
        <dd>
          <code>{identity.fingerprint}</code>{" "}
          <CopyButton text={identity.fingerprint} label="Copy key fingerprint" />
        </dd>
      </dl>
    </section>
  );
}

function InviteCard(): preact.JSX.Element {
  const action = useAction();
  const [invite, setInvite] = useState<Invite | null>(null);
  const create = (): Promise<void> =>
    action.run(async () => {
      setInvite(await api("/api/federation/invites", inviteSchema, { method: "POST" }));
    });
  return (
    <section class="card" aria-labelledby="fed-invite">
      <h3 id="fed-invite">Invite a peer</h3>
      <p class="muted">
        The token works once and expires in 15 minutes. Give it to the other instance's admin.
      </p>
      <button type="button" disabled={action.busy} onClick={create}>
        Create invite
      </button>
      <ErrorLine message={action.error} />
      {invite && (
        <div class="secret-box" role="status">
          <label>
            Invite token (shown only now)
            <input readOnly value={invite.token} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <CopyButton text={invite.token} label="Copy invite token" />
          <p class="muted">Expires {fmtTime(invite.expiresAt)}</p>
        </div>
      )}
    </section>
  );
}

function PairCard({ onChange }: { onChange: (message: string) => void }): preact.JSX.Element {
  const action = useAction();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const submit = (e: Event): void => {
    e.preventDefault();
    action.run(async () => {
      const peer = await api("/api/federation/peers/pair", pairedSchema, {
        method: "POST",
        body: { url: url.trim(), token: token.trim() },
      });
      setToken("");
      onChange(`Paired with ${peer.name}`);
    });
  };
  return (
    <section class="card" aria-labelledby="fed-pair">
      <h3 id="fed-pair">Pair with another instance</h3>
      <form class="row" onSubmit={submit}>
        <label>
          Instance URL
          <input
            type="url"
            required
            maxLength={500}
            placeholder="https://other.example.com"
            value={url}
            onInput={(e) => setUrl(e.currentTarget.value)}
          />
        </label>
        <label>
          Invite token
          <input
            required
            maxLength={200}
            autocomplete="off"
            value={token}
            onInput={(e) => setToken(e.currentTarget.value)}
          />
        </label>
        <button type="submit" disabled={action.busy}>
          Pair
        </button>
      </form>
      <ErrorLine message={action.error} />
    </section>
  );
}

const pairedSchema = z.object({ id: z.string(), name: z.string() });

// Every project of the orgs the person belongs to; the server decides who may share which.
async function loadProjects(): Promise<ProjectChoice[]> {
  const orgs = me.value?.orgs ?? [];
  const details = await Promise.all(orgs.map((o) => api(`/api/orgs/${o.slug}`, orgDetailSchema)));
  return details.flatMap((d) =>
    d.projects
      .filter((p) => p.orgId === d.org.id)
      .map((p) => ({ id: p.id, label: `${d.org.slug}/${p.key} ${p.name}` })),
  );
}

function FederationBody(): preact.JSX.Element {
  const [status, setStatus] = useState("");
  const identity = useLoad(() => api("/api/federation/identity", identitySchema), []);
  const peers = useLoad(() => api("/api/federation/peers", peersSchema), []);
  const shares = useLoad(() => api("/api/federation/shares", sharesSchema), []);
  const projects = useLoad(loadProjects, []);
  const changed = (message: string): void => {
    setStatus(message);
    peers.reload();
    shares.reload();
  };
  const failure = identity.error ?? peers.error ?? shares.error;
  return (
    <div class="distribution">
      <h2>Federation</h2>
      <p role="status" class="muted">
        {status}
      </p>
      <ErrorLine message={failure} />
      {identity.data && <IdentityCard identity={identity.data} />}
      <InviteCard />
      <PairCard onChange={changed} />
      <PeersCard peers={peers.data ?? []} onChange={changed} />
      <SharesCard
        shares={shares.data ?? []}
        peers={peers.data ?? []}
        projects={projects.data ?? []}
        onChange={changed}
      />
    </div>
  );
}

export function FederationPage(): preact.JSX.Element {
  if (me.value?.user.instanceAdmin !== true) return <p class="muted">Not available.</p>;
  return <FederationBody />;
}
