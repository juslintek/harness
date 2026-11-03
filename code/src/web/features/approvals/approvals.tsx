import { useState } from "preact/hooks";
import { z } from "zod";
import { type ApprovalView, approvalViewSchema } from "../../../shared/runs";
import { api, useLoad, useTopic } from "../../api";
import { errorText } from "../../format";

const listSchema = z.array(approvalViewSchema);

function ApprovalItem({
  approval,
  onDecided,
}: {
  approval: ApprovalView;
  onDecided: () => void;
}): preact.JSX.Element {
  const [message, setMessage] = useState<string | null>(null);
  const decide = async (decision: "approve" | "deny"): Promise<void> => {
    try {
      await api(`/api/approvals/${approval.id}`, approvalViewSchema, {
        method: "POST",
        body: { decision },
      });
    } catch (err) {
      setMessage(errorText(err));
    }
    onDecided();
  };
  return (
    <li class="card">
      <p class="muted">{approval.reason ?? "The guard needs a decision."}</p>
      <pre class="command">{approval.command}</pre>
      <div class="row">
        <button type="button" onClick={() => decide("approve")}>
          Approve
        </button>
        <button type="button" class="danger" onClick={() => decide("deny")}>
          Deny
        </button>
      </div>
      {message && (
        <p class="error" role="alert">
          {message}
        </p>
      )}
    </li>
  );
}

// Without a run id it lists every pending approval the server lets this user decide.
export function PendingApprovals({ runId }: { runId?: string }): preact.JSX.Element {
  const list = useLoad(() => api("/api/approvals?status=pending", listSchema), []);
  useTopic("approvals", list.reload);
  const mine = (list.data ?? []).filter((a) => runId === undefined || a.runId === runId);
  return (
    <section aria-labelledby="approvals-title">
      <h3 id="approvals-title">Pending approvals</h3>
      <p class="muted" role="status" aria-live="polite">
        {mine.length === 0
          ? "Nothing waiting for a decision."
          : `${mine.length} approval${mine.length === 1 ? "" : "s"} waiting for a decision.`}
      </p>
      <ul class="plain">
        {mine.map((a) => (
          <ApprovalItem key={a.id} approval={a} onDecided={list.reload} />
        ))}
      </ul>
    </section>
  );
}
