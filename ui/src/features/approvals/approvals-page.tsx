import { approvalViewSchema } from "@shared/runs";
import { For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { createLoad } from "../../load";
import { State } from "../../ui/primitives";
import "../runs/runs.css";
import { ApprovalCard } from "./approval-card";

const listSchema = z.array(approvalViewSchema);

// Same list and topic the shell counts from, so the badge and this page agree.
export function ApprovalsPage(): JSX.Element {
  const list = createLoad("/api/approvals?status=pending", listSchema, ["approvals"]);
  const count = (): number => list.data()?.length ?? 0;
  return (
    <div class="page-stack">
      <Show when={list.error()}>
        {(message) => <State kind="error" message={message()} onRetry={() => void list.reload()} />}
      </Show>
      <Show when={list.data()}>
        <p class="muted" role="status" aria-live="polite">
          {count() === 0
            ? "Nothing waiting for a decision."
            : `${count()} approval${count() === 1 ? "" : "s"} waiting for a decision.`}
        </p>
        <ul class="approval-list" aria-label="Pending approvals">
          <For each={list.data()}>
            {(approval) => (
              <li>
                <ApprovalCard approval={approval} onDecided={() => void list.reload()} />
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

// The server answers 404 to anyone who may not decide it, so there is no client-side role check.
export function ApprovalPage(props: { id: string }): JSX.Element {
  const approval = createLoad(`/api/approvals/${props.id}`, approvalViewSchema, ["approvals"]);
  return (
    <div class="page-stack">
      <Show
        when={approval.data()}
        fallback={
          <State
            kind={approval.error() ? "error" : "loading"}
            message={
              approval.error() === "unknown approval"
                ? "This approval does not exist, or you may not decide it."
                : (approval.error() ?? "Loading…")
            }
          />
        }
      >
        {(data) => (
          <div class="approval-list">
            <ApprovalCard approval={data()} onDecided={() => void approval.reload()} />
          </div>
        )}
      </Show>
    </div>
  );
}
