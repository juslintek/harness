import { type ApprovalView, approvalViewSchema } from "@shared/runs";
import { createSignal, type JSX, onCleanup, Show } from "solid-js";
import { api } from "../../api";
import { createAction } from "../../ui/action";
import { CodeBlock } from "../../ui/code-block";
import { Button, StatusBadge } from "../../ui/primitives";
import { APPROVAL_TONE } from "../runs/format";
import "./approvals.css";

const [now, setNow] = createSignal(Date.now());
let users = 0;
let ticker: ReturnType<typeof setInterval> | undefined;

// One shared clock for every card on the page; it stops when the last card goes.
function useNow(): () => number {
  if (users++ === 0) ticker = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => {
    if (--users === 0) clearInterval(ticker);
  });
  return now;
}

const countdown = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

// The same card on the approvals pages and inside a run. The run's agent is only known inside a run.
export function ApprovalCard(props: {
  approval: ApprovalView;
  agentId?: string;
  onDecided: () => void;
}): JSX.Element {
  const clock = useNow();
  const decision = createAction();
  const remaining = (): number => props.approval.expiresAt - clock();
  const open = (): boolean => props.approval.status === "pending" && remaining() > 0;
  const status = (): keyof typeof APPROVAL_TONE =>
    props.approval.status === "pending" && !open() ? "expired" : props.approval.status;
  const decide = (choice: "approve" | "deny"): Promise<void> =>
    decision
      .run(async () => {
        await api(`/api/approvals/${props.approval.id}`, approvalViewSchema, {
          method: "POST",
          body: { decision: choice },
        });
      })
      .then(props.onDecided);
  return (
    <section class="approval" data-status={status()} aria-labelledby={`ap-${props.approval.id}`}>
      <header class="approval-head">
        <StatusBadge tone={APPROVAL_TONE[status()]} value={status()} />
        <h3 id={`ap-${props.approval.id}`} class="approval-title">
          Approval needed
        </h3>
        <Show when={open()}>
          <span class="approval-expiry" role="timer">
            <strong>Expires in {countdown(remaining())}</strong>
            <span>at {new Date(props.approval.expiresAt).toLocaleTimeString()}</span>
          </span>
        </Show>
      </header>
      <div class="approval-body">
        <p>{props.approval.reason ?? "The guard needs a decision."}</p>
        <CodeBlock text={props.approval.command} label="command" />
        <div class="approval-meta">
          <Show when={props.agentId}>
            <span>
              Requested by{" "}
              <span class="mono">
                {props.agentId} · {props.approval.runId}
              </span>
            </span>
          </Show>
          <a href={`#/runs/${props.approval.runId}`}>Open the run</a>
          <Show when={props.approval.decidedBy}>{(by) => <span>Decided by {by()}</span>}</Show>
        </div>
        <Show when={open()}>
          <div class="approval-actions">
            <span class="hint">Deciding asks for your passkey.</span>
            <Button disabled={decision.busy()} onClick={() => decide("deny")}>
              Deny
            </Button>
            <Button tone="primary" disabled={decision.busy()} onClick={() => decide("approve")}>
              Approve
            </Button>
          </div>
        </Show>
        <Show when={decision.error()}>
          {(message) => (
            <p class="error" role="alert">
              {message()}
            </p>
          )}
        </Show>
      </div>
    </section>
  );
}
