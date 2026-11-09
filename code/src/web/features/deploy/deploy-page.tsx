import { useEffect, useState } from "preact/hooks";
import type { TargetView } from "../../../shared/distribution";
import { api, useLoad } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { me } from "../auth/me";
import { useAction } from "../auth/use-action";
import { deployRequestSchema, deployRequestsSchema, targetsSchema } from "./deploy-data";
import { RequestPanel } from "./request-panel";

const POLL_MS = 2000;

interface Options {
  binary: string;
  port: string;
}

function TargetRow({
  target,
  options,
  onChange,
}: {
  target: TargetView;
  options: Options;
  onChange: (message: string) => void;
}): preact.JSX.Element {
  const action = useAction();
  const request = (): Promise<void> =>
    action.run(async () => {
      const port = Number(options.port);
      await api("/api/deploy/requests", deployRequestSchema, {
        method: "POST",
        body: { targetId: target.id, binary: options.binary.trim(), ...(port > 0 && { port }) },
      });
      onChange(`Deploy request for ${target.name} created, review the steps below`);
    });
  return (
    <li class="target-line">
      <span>
        <strong>{target.name}</strong> <span class="badge">{target.kind}</span>{" "}
        <span class="muted">
          {target.user ? `${target.user}@` : ""}
          {target.address}
          {target.port ? `:${target.port}` : ""} {target.note ?? ""}
        </span>
      </span>
      {target.kind === "docker" ? (
        <span class="muted">Not supported yet</span>
      ) : (
        <button
          type="button"
          disabled={action.busy}
          aria-label={`Request deploy to ${target.name}`}
          onClick={request}
        >
          Request deploy
        </button>
      )}
      <ErrorLine message={action.error} />
    </li>
  );
}

function OptionsForm({
  options,
  set,
}: {
  options: Options;
  set: (o: Options) => void;
}): preact.JSX.Element {
  return (
    <div class="row">
      <label>
        Binary file name (in the dist folder)
        <input
          value={options.binary}
          required
          maxLength={300}
          onInput={(e) => set({ ...options, binary: e.currentTarget.value })}
        />
      </label>
      <label>
        Port on the new machine
        <input
          type="number"
          min={1}
          max={65535}
          value={options.port}
          onInput={(e) => set({ ...options, port: e.currentTarget.value })}
        />
      </label>
    </div>
  );
}

function DeployBody(): preact.JSX.Element {
  const [status, setStatus] = useState("");
  const [options, setOptions] = useState<Options>({ binary: "harness", port: "4100" });
  const targets = useLoad(() => api("/api/deploy/targets", targetsSchema), []);
  const requests = useLoad(() => api("/api/deploy/requests", deployRequestsSchema), []);
  const live = requests.data?.some((r) => r.status === "approved" || r.status === "running");
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(requests.reload, POLL_MS);
    return () => clearInterval(timer);
  }, [live, requests.reload]);
  const changed = (message: string): void => {
    setStatus(message);
    requests.reload();
  };
  return (
    <div class="distribution">
      <h2>Deploy</h2>
      <p>
        Only the harness binary and a small unit file are copied to the new machine. No login, key,
        database or secret leaves this instance, and the new machine asks you to log in to agents
        there.
      </p>
      <p role="status" class="muted">
        {status}
      </p>
      <ErrorLine message={targets.error ?? requests.error} />
      <h3>Targets</h3>
      <OptionsForm options={options} set={setOptions} />
      {targets.data?.length === 0 && <p class="muted">No ssh, tailscale or docker target found.</p>}
      <ul class="plain">
        {(targets.data ?? []).map((t) => (
          <TargetRow key={t.id} target={t} options={options} onChange={changed} />
        ))}
      </ul>
      <h3>Requests</h3>
      {requests.data?.length === 0 && <p class="muted">No deploy requests yet.</p>}
      {(requests.data ?? []).map((r) => (
        <RequestPanel key={r.id} request={r} onChange={changed} />
      ))}
    </div>
  );
}

export function DeployPage(): preact.JSX.Element {
  if (me.value?.user.instanceAdmin !== true) return <p class="muted">Not available.</p>;
  return <DeployBody />;
}
