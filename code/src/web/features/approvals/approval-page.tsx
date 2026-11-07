import { useEffect, useState } from "preact/hooks";
import { approvalViewSchema } from "../../../shared/runs";
import { api, useLoad, useTopic } from "../../api";
import { DecisionButtons } from "./approvals";

function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function ApprovalPage({ id }: { id: string }): preact.JSX.Element {
  const load = useLoad(() => api(`/api/approvals/${id}`, approvalViewSchema), [id]);
  useTopic("approvals", load.reload);
  const now = useNow();
  const approval = load.data;
  if (!approval) {
    return (
      <p class="muted" role={load.error ? "alert" : "status"}>
        {load.errorStatus === 404
          ? "This approval does not exist, or you may not decide it."
          : (load.error ?? "Loading…")}
      </p>
    );
  }
  const remaining = approval.expiresAt - now;
  const open = approval.status === "pending" && remaining > 0;
  return (
    <section class="approval-page card" aria-labelledby="approval-title">
      <h3 id="approval-title">Approval needed</h3>
      <p class="muted">{approval.reason ?? "The guard needs a decision."}</p>
      <pre class="command">{approval.command}</pre>
      <p>
        <a href={`#/runs/${approval.runId}`}>Open the run</a>
      </p>
      {open ? (
        <>
          <p class="muted" role="timer">
            Expires in {countdown(remaining)}
          </p>
          <DecisionButtons id={id} onDecided={load.reload} />
        </>
      ) : (
        <p role="status">
          {approval.status === "pending" ? "expired" : approval.status}
          {approval.decidedBy ? ` by ${approval.decidedBy}` : ""}
        </p>
      )}
    </section>
  );
}
