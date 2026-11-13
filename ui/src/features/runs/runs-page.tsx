import { approvalViewSchema, type RunView } from "@shared/runs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { createLoad } from "../../load";
import { selectedSlug } from "../../orgs";
import { Button, ButtonLink } from "../../ui/atoms";
import { EmptyPanel, State } from "../../ui/molecules";
import { countdown, useNow } from "../../ui/organisms";
import { createRunContext, isLive, reasonText, runList, whyStarted } from "./data";
import { fmtCost, fmtDuration, fmtStarted } from "./format";
import { RunRow, RunRowHead } from "./run-row";
import "./runs.css";
import { StartForm } from "./start-form";

const approvals = z.array(approvalViewSchema);
const asNumber = new Intl.NumberFormat();

function Group(props: {
  title: string;
  note?: string;
  runs: RunView[];
  row: (run: RunView) => JSX.Element;
}): JSX.Element {
  return (
    <Show when={props.runs.length > 0}>
      <h2 class="run-group">
        {props.title} <span class="run-group-count">{props.runs.length}</span>
        <Show when={props.note}>{(note) => <span class="run-group-note">{note()}</span>}</Show>
      </h2>
      <For each={props.runs}>{props.row}</For>
    </Show>
  );
}

export function RunsPage(): JSX.Element {
  const runs = createLoad("/api/runs", runList, ["runs"]);
  const pending = createLoad("/api/approvals?status=pending", approvals, ["approvals"]);
  const context = createRunContext();
  const now = useNow();
  const [starting, setStarting] = createSignal(false);
  const approvalOf = (runId: string) => (pending.data() ?? []).find((a) => a.runId === runId);
  const sorted = (): { waiting: RunView[]; active: RunView[]; finished: RunView[] } => {
    const all = runs.data() ?? [];
    const waiting = all.filter((r) => isLive(r.state) && approvalOf(r.id));
    const active = all.filter((r) => isLive(r.state) && !approvalOf(r.id));
    const finished = all
      .filter((r) => !isLive(r.state))
      .sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt));
    return { waiting, active, finished };
  };
  const row = (run: RunView): JSX.Element => {
    const approval = () => approvalOf(run.id);
    const why = () => whyStarted(context.wakeupOf(run.id), false);
    const usage = () => context.usageOf(run.id);
    const reason = reasonText(run);
    return (
      <RunRow
        id={run.id}
        title={run.prompt.split("\n")[0] ?? run.prompt}
        agent={run.agentId}
        model={run.model ?? "default model"}
        state={run.state}
        waiting={Boolean(approval())}
        {...(approval()
          ? {
              expires: `Expires in ${countdown(Math.max(0, (approval()?.expiresAt ?? 0) - now()))}`,
              reviewHref: `#/runs/${run.id}`,
            }
          : {})}
        {...(reason ? { reason } : {})}
        {...(why() ? { why: why()?.text ?? "" } : {})}
        {...(why()?.href ? { whyHref: why()?.href ?? "" } : {})}
        started={fmtStarted(run.startedAt ?? run.createdAt) ?? ""}
        {...(run.startedAt === null ? {} : { duration: fmtDuration(run.startedAt, run.endedAt) })}
        {...(fmtCost(usage()?.reportedCostUsd)
          ? { cost: fmtCost(usage()?.reportedCostUsd) ?? "" }
          : {})}
        {...(run.inputTokens + run.outputTokens > 0
          ? {
              tokens: `${asNumber.format(run.inputTokens)} in · ${asNumber.format(run.outputTokens)} out`,
            }
          : {})}
      />
    );
  };
  const slug = selectedSlug;
  return (
    <div class="page-stack">
      <div class="runs-head">
        <p class="runs-summary">
          <Show when={runs.data()?.length}>
            {sorted().waiting.length} waiting for you · {sorted().active.length} active ·{" "}
            {sorted().finished.length} finished
          </Show>
        </p>
        <Button tone="primary" onClick={() => setStarting(true)}>
          Start run
        </Button>
      </div>
      <p class="muted">
        A run is one agent working on one job in its own git worktree. Open a run to follow it live.
      </p>
      <Show when={runs.error()}>
        {(message) => <State kind="error" message={message()} onRetry={() => void runs.reload()} />}
      </Show>
      <Show when={runs.data()?.length === 0}>
        <EmptyPanel
          title="No runs yet"
          message="Start a run, or give an agent a task on the board."
        >
          <Button tone="primary" onClick={() => setStarting(true)}>
            Start run
          </Button>
          <Show when={slug()}>
            {(s) => (
              <>
                <ButtonLink href={`#/o/${s()}/board`}>Open board</ButtonLink>
                <ButtonLink href={`#/o/${s()}/chat`}>Open chat</ButtonLink>
              </>
            )}
          </Show>
        </EmptyPanel>
      </Show>
      <Show when={runs.data()?.length}>
        <section class="run-list" aria-label="Runs">
          <RunRowHead />
          <Group
            title="Waiting for you"
            note="Decide the command so the run can continue"
            runs={sorted().waiting}
            row={row}
          />
          <Group title="Active" runs={sorted().active} row={row} />
          <Group
            title="Finished"
            note="Newest first. The server returns the latest 50 runs."
            runs={sorted().finished}
            row={row}
          />
        </section>
      </Show>
      <StartForm open={starting()} onClose={() => setStarting(false)} />
    </div>
  );
}
