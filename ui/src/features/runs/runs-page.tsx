import { type RunView, runViewSchema } from "@shared/runs";
import { For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { createLoad } from "../../load";
import { TableBox } from "../../ui/data-table";
import { State, StatusBadge } from "../../ui/primitives";
import { fmtDuration, fmtTime, RUN_TONE } from "./format";
import "./runs.css";
import { StartForm } from "./start-form";

const listSchema = z.array(runViewSchema);

function RunRow(props: { run: RunView }): JSX.Element {
  return (
    <tr>
      <td>
        <a href={`#/runs/${props.run.id}`} aria-label={`Run ${props.run.id}, ${props.run.state}`}>
          <StatusBadge tone={RUN_TONE[props.run.state]} value={props.run.state} />
        </a>
      </td>
      <td>{props.run.agentId}</td>
      <td class="mono">{props.run.model ?? "-"}</td>
      <td class="mono">
        {props.run.inputTokens} / {props.run.outputTokens}
      </td>
      <td class="mono">{fmtDuration(props.run.startedAt, props.run.endedAt)}</td>
      <td class="mono">{fmtTime(props.run.startedAt ?? props.run.createdAt)}</td>
    </tr>
  );
}

export function RunsPage(): JSX.Element {
  const runs = createLoad("/api/runs", listSchema, ["runs"]);
  return (
    <div class="runs-layout">
      <div class="page-stack">
        <Show when={runs.error()}>
          {(message) => (
            <State kind="error" message={message()} onRetry={() => void runs.reload()} />
          )}
        </Show>
        <Show when={runs.data()?.length === 0}>
          <State kind="empty" message="No runs yet." />
        </Show>
        <Show when={runs.data()?.length}>
          <TableBox label="Runs">
            <thead>
              <tr>
                <th scope="col">State</th>
                <th scope="col">Agent</th>
                <th scope="col">Model</th>
                <th scope="col">Tokens in / out</th>
                <th scope="col">Duration</th>
                <th scope="col">Started</th>
              </tr>
            </thead>
            <tbody>
              <For each={runs.data()}>{(run) => <RunRow run={run} />}</For>
            </tbody>
          </TableBox>
        </Show>
      </div>
      <StartForm onStarted={() => void runs.reload()} />
    </div>
  );
}
