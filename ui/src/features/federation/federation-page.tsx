import { createResource, createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { ignored, me } from "../../auth/me";
import { errorText, minuteStamp } from "../../format";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { Button, CopyButton, Help, StatusBadge } from "../../ui/atoms";
import { Field, Notice, Panel, State, TableBox } from "../../ui/molecules";
import "../distribution/distribution.css";
import {
  type Identity,
  type Invite,
  identitySchema,
  inviteSchema,
  loadShareableProjects,
  type Peer,
  type ProjectChoice,
  pairedSchema,
  peersSchema,
  type Share,
  sharesSchema,
} from "./federation-data";

function IdentityCard(props: { identity: Identity }): JSX.Element {
  return (
    <Panel title="This instance">
      <dl class="dist-meta">
        <dt>Name</dt>
        <dd>{props.identity.name}</dd>
        <dt>Instance id</dt>
        <dd class="dist-inline">
          <code>{props.identity.instanceId}</code>
          <CopyButton text={props.identity.instanceId} label="Copy instance id" />
        </dd>
        <dt>Key fingerprint</dt>
        <dd class="dist-inline">
          <code>{props.identity.fingerprint}</code>
          <CopyButton text={props.identity.fingerprint} label="Copy key fingerprint" />
        </dd>
      </dl>
    </Panel>
  );
}

function InviteCard(): JSX.Element {
  const action = createAction();
  const [invite, setInvite] = createSignal<Invite | null>(null);
  const create = (): void => {
    void action.run(async () => {
      setInvite(await api("/api/federation/invites", inviteSchema, { method: "POST" }));
    });
  };
  return (
    <Panel title="Invite a peer">
      <div class="dist-stack">
        <Help small>
          The token works once and expires in 15 minutes. Give it to the other instance&apos;s
          admin.
        </Help>
        <div class="dist-inline">
          <Button tone="primary" disabled={action.busy()} onClick={create}>
            Create invite
          </Button>
        </div>
        <ErrorLine message={action.error()} />
        <Show when={invite()}>
          {(inv) => (
            <Notice tone="info" title={`Invite token expires ${minuteStamp(inv().expiresAt)}`}>
              <div class="dist-inline">
                <code>{inv().token}</code>
                <CopyButton text={inv().token} label="Copy invite token" />
              </div>
            </Notice>
          )}
        </Show>
      </div>
    </Panel>
  );
}

function PairCard(props: { onChange: (message: string) => void }): JSX.Element {
  const action = createAction();
  const [url, setUrl] = createSignal("");
  const [token, setToken] = createSignal("");
  const submit = (e: SubmitEvent): void => {
    e.preventDefault();
    void action.run(async () => {
      const peer = await api("/api/federation/peers/pair", pairedSchema, {
        method: "POST",
        body: { url: url().trim(), token: token().trim() },
      });
      setToken("");
      props.onChange(`Paired with ${peer.name}`);
    });
  };
  return (
    <Panel title="Pair with another instance">
      <div class="dist-stack">
        <form class="dist-row" onSubmit={submit}>
          <Field label="Instance URL">
            {(ctrl) => (
              <input
                {...ctrl()}
                type="url"
                required
                maxLength={500}
                placeholder="https://other.example.com"
                value={url()}
                onInput={(e) => setUrl(e.currentTarget.value)}
              />
            )}
          </Field>
          <Field label="Invite token">
            {(ctrl) => (
              <input
                {...ctrl()}
                required
                maxLength={200}
                autocomplete="off"
                value={token()}
                onInput={(e) => setToken(e.currentTarget.value)}
              />
            )}
          </Field>
          <Button type="submit" tone="primary" disabled={action.busy()}>
            Pair
          </Button>
        </form>
        <ErrorLine message={action.error()} />
      </div>
    </Panel>
  );
}

function PeersPanel(props: { peers: Peer[]; onChange: (message: string) => void }): JSX.Element {
  const action = createAction();
  const revoke = (peer: Peer): void => {
    void action.run(async () => {
      await api(`/api/federation/peers/${encodeURIComponent(peer.id)}`, ignored, {
        method: "DELETE",
      });
      props.onChange(`Revoked ${peer.name}`);
    });
  };
  return (
    <Panel title="Peers">
      <div class="dist-stack">
        <ErrorLine message={action.error()} />
        <Show
          when={props.peers.length > 0}
          fallback={
            <Help small>No peers yet. Create an invite here and pair from the other instance.</Help>
          }
        >
          <TableBox label="Federation peers" stack>
            <thead>
              <tr>
                <th>Name</th>
                <th>URL</th>
                <th>Fingerprint</th>
                <th>Last seen</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.peers}>
                {(peer) => (
                  <tr>
                    <td data-label="Name">{peer.name}</td>
                    <td data-label="URL">{peer.url}</td>
                    <td data-label="Fingerprint">
                      <code>{peer.fingerprint}</code>
                    </td>
                    <td data-label="Last seen">
                      {peer.lastSeenAt === null ? "Never" : minuteStamp(peer.lastSeenAt)}
                    </td>
                    <td data-label="Actions">
                      <Show
                        when={peer.revokedAt === null}
                        fallback={<StatusBadge tone="danger" value="revoked" />}
                      >
                        <Button
                          size="sm"
                          tone="danger-quiet"
                          disabled={action.busy()}
                          aria-label={`Revoke ${peer.name}`}
                          onClick={() => revoke(peer)}
                        >
                          Revoke
                        </Button>
                      </Show>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </TableBox>
        </Show>
      </div>
    </Panel>
  );
}

function SharesPanel(props: {
  shares: Share[];
  peers: Peer[];
  projects: ProjectChoice[];
  onChange: (message: string) => void;
}): JSX.Element {
  const action = createAction();
  const [projectId, setProjectId] = createSignal("");
  const [peerId, setPeerId] = createSignal("");
  const [permission, setPermission] = createSignal<"read" | "write">("read");
  const activePeers = (): Peer[] => props.peers.filter((p) => p.revokedAt === null);

  const share = (e: SubmitEvent): void => {
    e.preventDefault();
    void action.run(async () => {
      await api("/api/federation/shares", ignored, {
        method: "POST",
        body: { projectId: projectId(), peerId: peerId(), permission: permission() },
      });
      props.onChange("Share created");
    });
  };

  const revoke = (s: Share): void => {
    void action.run(async () => {
      await api(
        `/api/federation/shares/${encodeURIComponent(s.projectId)}/${encodeURIComponent(s.peerId)}`,
        ignored,
        { method: "DELETE" },
      );
      props.onChange(`Stopped sharing ${s.projectName}`);
    });
  };

  return (
    <Panel title="Shared projects">
      <div class="dist-stack">
        <Show
          when={props.shares.length > 0}
          fallback={<Help small>Nothing is shared with a peer.</Help>}
        >
          <ul class="dist-list">
            <For each={props.shares}>
              {(s) => (
                <li class="dist-line">
                  <span>
                    {s.projectName} with {s.peerName ?? s.peerId} ({s.permission})
                  </span>
                  <Button
                    size="sm"
                    tone="danger-quiet"
                    disabled={action.busy()}
                    aria-label={`Stop sharing ${s.projectName} with ${s.peerName ?? s.peerId}`}
                    onClick={() => revoke(s)}
                  >
                    Revoke
                  </Button>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <form class="dist-row" onSubmit={share}>
          <Field label="Project">
            {(ctrl) => (
              <select
                {...ctrl()}
                required
                value={projectId()}
                onChange={(e) => setProjectId(e.currentTarget.value)}
              >
                <option value="">Choose a project</option>
                <For each={props.projects}>{(p) => <option value={p.id}>{p.label}</option>}</For>
              </select>
            )}
          </Field>
          <Field label="Peer">
            {(ctrl) => (
              <select
                {...ctrl()}
                required
                value={peerId()}
                onChange={(e) => setPeerId(e.currentTarget.value)}
              >
                <option value="">Choose a peer</option>
                <For each={activePeers()}>{(p) => <option value={p.id}>{p.name}</option>}</For>
              </select>
            )}
          </Field>
          <Field label="Permission">
            {(ctrl) => (
              <select
                {...ctrl()}
                value={permission()}
                onChange={(e) =>
                  setPermission(e.currentTarget.value === "write" ? "write" : "read")
                }
              >
                <option value="read">read</option>
                <option value="write">write</option>
              </select>
            )}
          </Field>
          <Button type="submit" tone="primary" disabled={action.busy()}>
            Share project
          </Button>
        </form>
        <ErrorLine message={action.error()} />
      </div>
    </Panel>
  );
}

function FederationBody(): JSX.Element {
  const [status, setStatus] = createSignal<string | null>(null);
  const identity = createLoad("/api/federation/identity", identitySchema);
  const peers = createLoad("/api/federation/peers", peersSchema);
  const shares = createLoad("/api/federation/shares", sharesSchema);
  const [projects] = createResource(loadShareableProjects);

  const changed = (message: string): void => {
    setStatus(message);
    void peers.reload();
    void shares.reload();
  };

  const failure = (): string | null =>
    identity.error() ??
    peers.error() ??
    shares.error() ??
    (projects.error ? errorText(projects.error) : null);

  return (
    <div class="dist-page">
      <h1>Federation</h1>
      <Help>
        Pair with other Harness instances using Ed25519 keys and share projects without syncing
        credentials or secrets.
      </Help>
      <Show when={status()}>
        {(msg) => (
          <Notice tone="success" title="Updated">
            {msg()}
          </Notice>
        )}
      </Show>
      <ErrorLine message={failure()} />
      <Show when={identity.data()}>{(id) => <IdentityCard identity={id()} />}</Show>
      <InviteCard />
      <PairCard onChange={changed} />
      <PeersPanel peers={peers.data() ?? []} onChange={changed} />
      <SharesPanel
        shares={shares.data() ?? []}
        peers={peers.data() ?? []}
        projects={projects() ?? []}
        onChange={changed}
      />
    </div>
  );
}

export function FederationPage(): JSX.Element {
  return (
    <Show
      when={me()?.user.instanceAdmin === true}
      fallback={<State kind="empty" message="Not available." />}
    >
      <FederationBody />
    </Show>
  );
}
