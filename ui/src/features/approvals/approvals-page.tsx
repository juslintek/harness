import { type ApprovalView, approvalViewSchema, runViewSchema } from "@shared/runs";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { me } from "../../auth/me";
import { createLoad } from "../../load";
import { Button, Help } from "../../ui/atoms";
import { EmptyPanel, State, Tabs } from "../../ui/molecules";
import { DecidableApprovalCard, useNow } from "../../ui/organisms";
import "../runs/runs.css";
import "./approvals.css";

const listSchema = z.array(approvalViewSchema);
const runList = z.array(runViewSchema);

// An approval is waiting until it is decided or its time is up.
const isWaiting = (a: ApprovalView, now: number): boolean =>
  a.status === "pending" && a.expiresAt > now;

// The server lets only instance admins subscribe to the approvals topic and read runs; anyone
// else sees a list that refreshes when the page is opened again.
export function ApprovalsPage(props: { tab?: "waiting" | "decided" }): JSX.Element {
  const admin = me()?.user.instanceAdmin === true;
  const list = createLoad("/api/approvals", listSchema, admin ? ["approvals"] : []);
  const runs = admin ? createLoad("/api/runs", runList, ["runs"]) : null;
  const now = useNow();
  const agentOf = (runId: string): string | undefined =>
    runs?.data()?.find((r) => r.id === runId)?.agentId;
  // Decided here stay on the page until it is left, so the result line has somewhere to show.
  const [kept, setKept] = createSignal<ApprovalView[]>([]);
  const waiting = createMemo(() =>
    (list.data() ?? [])
      .filter((a) => isWaiting(a, now()))
      .sort((a, b) => a.expiresAt - b.expiresAt),
  );
  const rows = createMemo(() => {
    const current = new Map(waiting().map((a) => [a.id, a]));
    const extra = kept().filter((a) => !current.has(a.id));
    return [...current.values(), ...extra].sort((a, b) => a.expiresAt - b.expiresAt);
  });
  const decided = createMemo(() => {
    const live = new Set(rows().map((a) => a.id));
    return (list.data() ?? [])
      .filter((a) => !isWaiting(a, now()) && !live.has(a.id))
      .sort((a, b) => (b.decidedAt ?? b.expiresAt) - (a.decidedAt ?? a.expiresAt));
  });
  const tab = (): "waiting" | "decided" => props.tab ?? "waiting";
  return (
    <div class="page-stack approvals">
      <Tabs
        label="Approvals"
        current={tab()}
        items={[
          { key: "waiting", label: "Waiting", href: "#/approvals", count: waiting().length },
          { key: "decided", label: "Decided", href: "#/approvals/decided" },
        ]}
      />
      <Help>
        Instance admins, and owners or admins of the org that owns the run's project, can decide.
        Deciding asks for your passkey.
      </Help>
      <Show when={tab() === "waiting"}>
        <Help small>
          Soonest to expire first. If nobody decides in time, the request expires and the agent is
          told no.
        </Help>
      </Show>
      <Show when={list.error()}>
        {(message) => <State kind="error" message={message()} onRetry={() => void list.reload()} />}
      </Show>
      <Show when={list.data()}>
        <Show when={tab() === "waiting"}>
          <Show
            when={rows().length > 0}
            fallback={
              <EmptyPanel
                title="Nothing waiting for a decision"
                message="Approvals are the commands an agent asked to run that the guard wants you to check. Guard rules are set in Policies."
              >
                <Show when={me()?.orgs[0]}>
                  {(org) => (
                    <Button onClick={() => (location.hash = `#/o/${org().slug}/policies`)}>
                      Open Policies
                    </Button>
                  )}
                </Show>
                <Button onClick={() => (location.hash = "#/approvals/decided")}>
                  See decided approvals
                </Button>
              </EmptyPanel>
            }
          >
            <ul class="approval-list" aria-label="Waiting approvals">
              <For each={rows().map((a) => a.id)}>
                {(id) => {
                  const approval = (): ApprovalView =>
                    rows().find((a) => a.id === id) as ApprovalView;
                  return (
                    <li>
                      <DecidableApprovalCard
                        approval={approval()}
                        agentId={agentOf(approval().runId)}
                        onDecided={(updated) => {
                          if (updated) setKept([...kept(), updated]);
                          void list.reload();
                        }}
                      />
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        </Show>
        <Show when={tab() === "decided"}>
          <Show
            when={decided().length > 0}
            fallback={<State kind="empty" message="Nothing has been decided yet." />}
          >
            <ul class="approval-list" aria-label="Decided approvals">
              <For each={decided()}>
                {(a) => (
                  <li>
                    <DecidableApprovalCard
                      approval={a}
                      agentId={agentOf(a.runId)}
                      onDecided={() => undefined}
                    />
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>
    </div>
  );
}

// The server answers 404 to anyone who may not decide it, so there is no client-side role check.
function ApprovalDetail(props: { id: string }): JSX.Element {
  const approval = createLoad(
    `/api/approvals/${props.id}`,
    approvalViewSchema,
    me()?.user.instanceAdmin ? ["approvals"] : [],
  );
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
            <DecidableApprovalCard approval={data()} onDecided={() => void approval.reload()} />
          </div>
        )}
      </Show>
    </div>
  );
}

// "decided" is the second tab's address, so it is not an approval id.
export function ApprovalPage(props: { id: string }): JSX.Element {
  return props.id === "decided" ? (
    <ApprovalsPage tab="decided" />
  ) : (
    <ApprovalDetail id={props.id} />
  );
}
