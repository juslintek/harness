import type { ApprovalView, RunView } from "@shared/runs";
import { createSignal, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { createAction } from "../../ui/action";
import { Button, StatusBadge } from "../../ui/atoms";
import { ConfirmDialog } from "../../ui/molecules";
import { isLive, type Why } from "./data";
import { fmtDuration } from "./format";

const okSchema = z.object({ ok: z.literal(true) });
const hhmmss = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour12: false });

export function RunHeader(props: {
  run: RunView;
  approval: ApprovalView | undefined;
  why: Why | undefined;
  taskNumber: number | null | undefined;
  onStopped: () => void;
}): JSX.Element {
  const [asking, setAsking] = createSignal(false);
  const stop = createAction();
  const r = (): RunView => props.run;
  const waiting = (): boolean => isLive(r().state) && props.approval !== undefined;
  return (
    <header class="run-header">
      <div class="run-head">
        <h2 class="run-id">{r().id}</h2>
        <Show when={waiting()} fallback={<StatusBadge kind="run" value={r().state} />}>
          <StatusBadge tone="warning" value="waiting for you" />
        </Show>
        <span class="run-head-spacer" />
        <Show when={isLive(r().state)}>
          <Button tone="danger-quiet" disabled={stop.busy()} onClick={() => setAsking(true)}>
            Stop run
          </Button>
        </Show>
      </div>
      <Show when={waiting() && props.approval}>
        {(approval) => (
          <p class="run-line">
            Paused since {hhmmss(approval().createdAt)}. It continues when someone approves or
            denies the command below.
          </p>
        )}
      </Show>
      <p class="run-line muted">
        <Show when={props.taskNumber !== null && props.taskNumber !== undefined && props.why?.href}>
          <span>
            For task <a href={props.why?.href}>#{props.taskNumber}</a> ·{" "}
          </span>
        </Show>
        {isLive(r().state) ? "running for" : "ran for"} {fmtDuration(r().startedAt, r().endedAt)}
        <Show when={r().startedAt}>{(at) => <> · started {hhmmss(at())}</>}</Show>
      </p>
      <Show when={stop.error()}>
        {(message) => (
          <p class="error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <ConfirmDialog
        open={asking()}
        title={`Stop run ${r().id}?`}
        message={`The agent stops now and the run ends as killed. You cannot resume it. Stopping asks for your passkey.`}
        confirm="Stop run"
        onClose={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          void stop
            .run(async () => {
              await api(`/api/runs/${r().id}/kill`, okSchema, { method: "POST", body: {} });
            })
            .then(props.onStopped);
        }}
      />
    </header>
  );
}
