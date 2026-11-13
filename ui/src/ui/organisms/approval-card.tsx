import type { ApprovalView } from "@shared/runs";
import { type JSX, Show } from "solid-js";
import { Button, ButtonLink, StatusBadge, statusWord } from "../atoms";
import { CodeBlock } from "../molecules";
import "./approval-card.css";
import { countdown, useNow } from "./clock";

// Title is the command's first three words, so a long command still reads at a glance.
export function approvalTitle(command: string): string {
  const words = command.trim().split(/\s+/);
  return words.length > 3 ? `${words.slice(0, 3).join(" ")} …` : words.join(" ");
}

const clock = (ms: number): string => new Date(ms).toLocaleTimeString("en-GB");

// One approval as a card. It fetches nothing: the caller passes what it knows and the two callbacks.
// Without `onApprove` and `onDeny` the card is read-only.
export function ApprovalCard(props: {
  approval: ApprovalView;
  // Known only to people who may read runs; the line and the link are left out without them.
  agent?: string | undefined;
  runHref?: string | undefined;
  // Now puts an Open run link beside the decision buttons; the Approvals list already links the run id.
  runButton?: boolean | undefined;
  // Who decided, as a person would say it ("you").
  decidedBy?: string | undefined;
  busy?: boolean;
  onApprove?: () => void;
  onDeny?: () => void;
  // The result of the decision or the refusal, drawn under the command.
  notice?: JSX.Element;
  error?: string | null | undefined;
}): JSX.Element {
  const now = useNow();
  const remaining = (): number => props.approval.expiresAt - now();
  const open = (): boolean => props.approval.status === "pending" && remaining() > 0;
  const status = (): ApprovalView["status"] =>
    props.approval.status === "pending" && !open() ? "expired" : props.approval.status;
  const title = approvalTitle(props.approval.command);
  const id = `ap-${props.approval.id}`;
  return (
    <section class="approval-card" data-status={status()} aria-labelledby={id}>
      <header class="approval-card-head">
        <StatusBadge
          tone={statusWord(status(), "approval").tone}
          value={statusWord(status(), "approval").word}
        />
        <h3 id={id} class="approval-card-title">
          {title}
        </h3>
        <Show when={open()}>
          <span class="approval-card-expiry" role="timer">
            <strong>Expires in {countdown(remaining())}</strong>
            <span>at {clock(props.approval.expiresAt)}</span>
          </span>
        </Show>
      </header>
      <div class="approval-card-body">
        <p class="approval-card-sub">
          <Show when={props.agent}>
            {(agent) => (
              <>
                <span>
                  Asked by <span class="approval-card-agent">@{agent()}</span>
                </span>
                <span aria-hidden="true">·</span>
              </>
            )}
          </Show>
          <Show when={props.runHref}>
            {(href) => (
              <>
                <span>
                  Run <a href={href()}>{props.approval.runId}</a>
                </span>
                <span aria-hidden="true">·</span>
              </>
            )}
          </Show>
          <span class="approval-card-id">{props.approval.id}</span>
        </p>
        <p class="approval-card-reason">
          {props.approval.reason ??
            "No reason given. Open the run to see what the agent was doing."}
        </p>
        <CodeBlock text={props.approval.command} label="command" prompt />
        {props.notice}
        <Show when={!props.notice && (props.approval.status !== "pending" || !open())}>
          <p class="approval-card-decided">
            {status() === "expired"
              ? "No decision before it expired."
              : `${status() === "approved" ? "Approved" : "Denied"} by ${props.decidedBy ?? props.approval.decidedBy ?? "someone"}${props.approval.decidedAt ? ` at ${clock(props.approval.decidedAt)}` : ""}.`}
          </p>
        </Show>
        <Show when={open() && props.onApprove && props.onDeny}>
          <div class="approval-card-actions">
            <Button disabled={props.busy} onClick={() => props.onDeny?.()}>
              Deny
            </Button>
            <Button tone="primary" disabled={props.busy} onClick={() => props.onApprove?.()}>
              Approve command
            </Button>
            <Show when={props.runButton && props.runHref}>
              {(href) => <ButtonLink href={href()}>Open run</ButtonLink>}
            </Show>
          </div>
        </Show>
        <Show when={props.error}>
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
