import { useEffect, useState } from "preact/hooks";
import { api } from "../../api";
import { fmtTime } from "../../format";
import { ErrorLine } from "../auth/error-line";
import { me } from "../auth/me";
import { useAction } from "../auth/use-action";
import { ReviewPanel } from "./review-panel";
import {
  isFinished,
  rememberedIds,
  rememberId,
  type UpdateRequestView,
  updateRequestSchema,
} from "./selfupdate-data";

const POLL_MS = 3000;

function RequestForm({
  onCreated,
}: {
  onCreated: (r: UpdateRequestView) => void;
}): preact.JSX.Element {
  const action = useAction();
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const submit = (e: Event): void => {
    e.preventDefault();
    action.run(async () => {
      const created = await api("/api/selfupdate/requests", updateRequestSchema, {
        method: "POST",
        body: { repo: repo.trim(), branch: branch.trim() },
      });
      rememberId(created.id);
      onCreated(created);
    });
  };
  return (
    <form class="row" onSubmit={submit}>
      <label>
        Repository path
        <input value={repo} required onInput={(e) => setRepo(e.currentTarget.value)} />
      </label>
      <label>
        Branch
        <input value={branch} required onInput={(e) => setBranch(e.currentTarget.value)} />
      </label>
      <button type="submit" disabled={action.busy}>
        Request update
      </button>
      <ErrorLine message={action.error} />
    </form>
  );
}

function RequestItem({
  request,
  onChange,
}: {
  request: UpdateRequestView;
  onChange: (message: string) => void;
}): preact.JSX.Element {
  return (
    <li class="card">
      <p>
        <strong>{request.branch}</strong> <span class="muted">{request.repo}</span>{" "}
        <span class={`badge ${request.status}`}>{request.status}</span>
      </p>
      <p class="muted">
        {fmtTime(request.createdAt)}, <code>{request.commitSha.slice(0, 12)}</code>
        {request.reason ? `, ${request.reason}` : ""}
      </p>
      {request.status === "awaiting_approval" && (
        <ReviewPanel request={request} onChange={onChange} />
      )}
    </li>
  );
}

// One GET per remembered id; a request the server no longer knows is skipped.
async function loadAll(ids: string[]): Promise<UpdateRequestView[]> {
  const loaded = await Promise.all(
    ids.map((id) =>
      api(`/api/selfupdate/requests/${encodeURIComponent(id)}`, updateRequestSchema).catch(
        () => null,
      ),
    ),
  );
  return loaded.filter((r): r is UpdateRequestView => r !== null);
}

function UpdatesBody(): preact.JSX.Element {
  const [status, setStatus] = useState("");
  const [requests, setRequests] = useState<UpdateRequestView[]>([]);
  const [tick, setTick] = useState(0);
  const busy = requests.some((r) => !isFinished(r.status) && r.status !== "awaiting_approval");
  useEffect(() => {
    let live = true;
    loadAll(rememberedIds()).then((all) => live && setRequests(all));
    return () => {
      live = false;
    };
  }, [tick]);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setTick((n) => n + 1), POLL_MS);
    return () => clearInterval(timer);
  }, [busy]);
  const changed = (message: string): void => {
    setStatus(message);
    setTick((n) => n + 1);
  };
  return (
    <div class="distribution">
      <h2>Updates</h2>
      <p>
        Update this instance from a branch. The pipeline checks, builds and verifies the new binary
        on a copy of the data, then swaps, and rolls back if the new version does not answer.
        Changes to guard, auth or sandbox code wait here for your approval.
      </p>
      <p role="status" class="muted">
        {status}
      </p>
      <RequestForm onCreated={(r) => changed(`Update request for ${r.branch} created`)} />
      <h3>Requests</h3>
      {requests.length === 0 && <p class="muted">No update requests from this browser yet.</p>}
      <ul class="plain">
        {requests.map((r) => (
          <RequestItem key={r.id} request={r} onChange={changed} />
        ))}
      </ul>
    </div>
  );
}

export function UpdatesPage(): preact.JSX.Element {
  if (me.value?.user.instanceAdmin !== true) return <p class="muted">Not available.</p>;
  return <UpdatesBody />;
}
