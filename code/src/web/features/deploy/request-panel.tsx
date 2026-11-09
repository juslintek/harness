import { useRef } from "preact/hooks";
import { api } from "../../api";
import { fmtTime } from "../../format";
import { ErrorLine } from "../auth/error-line";
import { useAction } from "../auth/use-action";
import { type DeployRequestView, deployRequestSchema } from "./deploy-data";
import { PlanSteps } from "./plan-view";

interface Props {
  request: DeployRequestView;
  onChange: (message: string) => void;
}

const DECISION_LABEL = { approve: "Approved", deny: "Denied" } as const;

function Buttons({ request, onChange }: Props): preact.JSX.Element | null {
  const action = useAction();
  const status = useRef<HTMLParagraphElement>(null);
  const base = `/api/deploy/requests/${encodeURIComponent(request.id)}`;
  const decide = (decision: "approve" | "deny"): Promise<void> =>
    action.run(async () => {
      await api(`${base}/decide`, deployRequestSchema, { method: "POST", body: { decision } });
      onChange(`${DECISION_LABEL[decision]} deploy to ${request.target.name}`);
      status.current?.focus();
    });
  const run = (): Promise<void> =>
    action.run(async () => {
      await api(`${base}/run`, deployRequestSchema, { method: "POST" });
      onChange(`Deploy to ${request.target.name} started`);
      status.current?.focus();
    });
  return (
    <div>
      <p ref={status} tabIndex={-1} class="muted">
        Status: <span class={`badge ${request.status}`}>{request.status}</span>
      </p>
      {request.status === "pending" && (
        <div class="row-buttons">
          <button type="button" disabled={action.busy} onClick={() => decide("approve")}>
            Approve (passkey)
          </button>
          <button type="button" disabled={action.busy} onClick={() => decide("deny")}>
            Deny
          </button>
        </div>
      )}
      {request.status === "approved" && (
        <button type="button" disabled={action.busy} onClick={run}>
          Run deploy
        </button>
      )}
      <ErrorLine message={action.error} />
    </div>
  );
}

export function RequestPanel({ request, onChange }: Props): preact.JSX.Element {
  const { target } = request;
  return (
    <article class="card" aria-label={`Deploy request for ${target.name}`}>
      <h4>
        {target.name}{" "}
        <span class="muted">
          ({target.kind}, port {request.port})
        </span>
      </h4>
      <p class="muted">
        Requested {fmtTime(request.createdAt)}, binary sha256 <code>{request.binarySha256}</code>
      </p>
      <PlanSteps plan={request.steps} />
      <Buttons request={request} onChange={onChange} />
      {(request.status === "done" || request.status === "failed") && request.result != null && (
        <pre>{JSON.stringify(request.result, null, 2)}</pre>
      )}
    </article>
  );
}
