import { useRef } from "preact/hooks";
import { api } from "../../api";
import { fmtTime } from "../../format";
import { ErrorLine } from "../auth/error-line";
import { ignored } from "../auth/me";
import { useAction } from "../auth/use-action";
import type { Peer } from "./federation-data";

interface Props {
  peers: Peer[];
  onChange: (message: string) => void;
}

export function PeersCard({ peers, onChange }: Props): preact.JSX.Element {
  const heading = useRef<HTMLHeadingElement>(null);
  const action = useAction();
  const revoke = (peer: Peer): Promise<void> =>
    action.run(async () => {
      await api(`/api/federation/peers/${encodeURIComponent(peer.id)}`, ignored, {
        method: "DELETE",
      });
      onChange(`Revoked ${peer.name}`);
      // The row with the focused button is gone; keep keyboard users on the section.
      heading.current?.focus();
    });
  return (
    <section class="card" aria-labelledby="fed-peers">
      <h3 id="fed-peers" ref={heading} tabIndex={-1}>
        Peers
      </h3>
      <ErrorLine message={action.error} />
      {peers.length === 0 ? (
        <p class="muted">No peers yet. Create an invite here and pair from the other instance.</p>
      ) : (
        <table class="stack">
          <thead>
            <tr>
              <th>Name</th>
              <th>URL</th>
              <th>Fingerprint</th>
              <th>Last seen</th>
              <th>
                <span class="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {peers.map((peer) => (
              <tr key={peer.id}>
                <td data-label="Name">{peer.name}</td>
                <td data-label="URL">{peer.url}</td>
                <td data-label="Fingerprint">
                  <code>{peer.fingerprint}</code>
                </td>
                <td data-label="Last seen">{fmtTime(peer.lastSeenAt)}</td>
                <td>
                  {peer.revokedAt === null ? (
                    <button
                      type="button"
                      disabled={action.busy}
                      aria-label={`Revoke ${peer.name}`}
                      onClick={() => revoke(peer)}
                    >
                      Revoke
                    </button>
                  ) : (
                    <span class="muted">Revoked</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
