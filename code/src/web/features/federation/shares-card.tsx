import { useRef, useState } from "preact/hooks";
import { api } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { ignored } from "../auth/me";
import { useAction } from "../auth/use-action";
import type { Peer, ProjectChoice, Share } from "./federation-data";

interface Props {
  shares: Share[];
  peers: Peer[];
  projects: ProjectChoice[];
  onChange: (message: string) => void;
}

function ShareForm({ peers, projects, onChange }: Omit<Props, "shares">): preact.JSX.Element {
  const action = useAction();
  const [projectId, setProjectId] = useState("");
  const [peerId, setPeerId] = useState("");
  const [permission, setPermission] = useState<"read" | "write">("read");
  const active = peers.filter((p) => p.revokedAt === null);
  const submit = (e: Event): void => {
    e.preventDefault();
    action.run(async () => {
      await api("/api/federation/shares", ignored, {
        method: "POST",
        body: { projectId, peerId, permission },
      });
      onChange("Share created");
    });
  };
  return (
    <form class="row" onSubmit={submit}>
      <label>
        Project
        <select value={projectId} required onChange={(e) => setProjectId(e.currentTarget.value)}>
          <option value="">Choose a project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Peer
        <select value={peerId} required onChange={(e) => setPeerId(e.currentTarget.value)}>
          <option value="">Choose a peer</option>
          {active.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Permission
        <select
          value={permission}
          onChange={(e) => setPermission(e.currentTarget.value === "write" ? "write" : "read")}
        >
          <option value="read">read</option>
          <option value="write">write</option>
        </select>
      </label>
      <button type="submit" disabled={action.busy}>
        Share project
      </button>
      <ErrorLine message={action.error} />
    </form>
  );
}

export function SharesCard(props: Props): preact.JSX.Element {
  const heading = useRef<HTMLHeadingElement>(null);
  const action = useAction();
  const revoke = (share: Share): Promise<void> =>
    action.run(async () => {
      await api(
        `/api/federation/shares/${encodeURIComponent(share.projectId)}/${encodeURIComponent(share.peerId)}`,
        ignored,
        { method: "DELETE" },
      );
      props.onChange(`Stopped sharing ${share.projectName}`);
      heading.current?.focus();
    });
  return (
    <section class="card" aria-labelledby="fed-shares">
      <h3 id="fed-shares" ref={heading} tabIndex={-1}>
        Shared projects
      </h3>
      <ErrorLine message={action.error} />
      {props.shares.length === 0 ? (
        <p class="muted">Nothing is shared with a peer.</p>
      ) : (
        <ul class="plain">
          {props.shares.map((s) => (
            <li key={`${s.projectId}:${s.peerId}`} class="share-line">
              <span>
                {s.projectName} with {s.peerName ?? s.peerId} ({s.permission})
              </span>
              <button
                type="button"
                disabled={action.busy}
                aria-label={`Stop sharing ${s.projectName} with ${s.peerName ?? s.peerId}`}
                onClick={() => revoke(s)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      <h4>Share a project</h4>
      <ShareForm peers={props.peers} projects={props.projects} onChange={props.onChange} />
    </section>
  );
}
