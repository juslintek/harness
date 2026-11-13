import { type ApprovalView, approvalViewSchema } from "@shared/runs";
import { createSignal, type JSX, Show } from "solid-js";
import { ApiError, api } from "../../api";
import { me } from "../../auth/me";
import { createAction } from "../action";
import { Button } from "../atoms";
import { Notice } from "../molecules";
import { ApprovalCard as ApprovalCardView, approvalTitle } from "./approval-card";

// Who decided, as a person would say it. The server only stores `user:<id>`.
const decidedByLabel = (by: string | null): string | undefined => {
  if (by === null) return undefined;
  const id = by.replace(/^user:/, "");
  return id === me()?.user.id ? "you" : id;
};

// The card plus its Deny and Approve calls. Used on the approvals pages and inside a run.
export function DecidableApprovalCard(props: {
  approval: ApprovalView;
  agentId?: string | undefined;
  runButton?: boolean | undefined;
  onDecided: (updated?: ApprovalView) => void;
}): JSX.Element {
  const decision = createAction();
  const [decided, setDecided] = createSignal<ApprovalView>();
  const [refusal, setRefusal] = createSignal<string | null>();
  const approval = (): ApprovalView => decided() ?? props.approval;
  // Run pages are for instance admins only, so the link is left out for everyone else.
  const runHref = (): string | undefined =>
    me()?.user.instanceAdmin ? `#/runs/${approval().runId}` : undefined;
  const openRun = (): JSX.Element => (
    <Show when={runHref()}>
      {(href) => (
        <Button
          onClick={() => {
            location.hash = href();
          }}
        >
          Open run
        </Button>
      )}
    </Show>
  );
  const decide = (choice: "approve" | "deny"): Promise<void> =>
    decision.run(async () => {
      setRefusal(undefined);
      try {
        const updated = await api(`/api/approvals/${props.approval.id}`, approvalViewSchema, {
          method: "POST",
          body: { decision: choice },
        });
        setDecided(updated);
        props.onDecided(updated);
      } catch (err) {
        if (
          err instanceof ApiError &&
          err.status === 403 &&
          err.message === "instance_admin_required"
        ) {
          setRefusal(err.reason ?? "This command needs an instance admin.");
        } else if (err instanceof ApiError && err.status === 409) props.onDecided();
        else throw err;
      }
    });
  const notice = (): JSX.Element => {
    const reason = refusal();
    if (reason !== undefined && reason !== null) {
      return (
        <Notice
          tone="danger"
          title="Only an instance admin can decide this one"
          actions={openRun()}
        >
          {reason}
        </Notice>
      );
    }
    const done = decided();
    if (!done) return null;
    const title = approvalTitle(done.command);
    const at = done.decidedAt ? new Date(done.decidedAt).toLocaleTimeString() : "";
    return (
      <Notice tone="success" actions={openRun()}>
        {done.status === "approved"
          ? `Approved ${title}. Run ${done.runId} can run this command now. Approved by you at ${at}.`
          : `Denied ${title}. The command will not run.`}
      </Notice>
    );
  };
  return (
    <ApprovalCardView
      approval={approval()}
      agent={props.agentId}
      runHref={runHref()}
      runButton={props.runButton}
      decidedBy={decidedByLabel(approval().decidedBy)}
      busy={decision.busy()}
      onApprove={() => void decide("approve")}
      onDeny={() => void decide("deny")}
      notice={notice()}
      error={decision.error()}
    />
  );
}
