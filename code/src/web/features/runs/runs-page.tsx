import { z } from "zod";
import { type RunView, runViewSchema } from "../../../shared/runs";
import { api, useLoad, useTopic } from "../../api";
import { fmtDuration, fmtTime } from "../../format";
import { StartForm } from "./start-form";

const listSchema = z.array(runViewSchema);

function RunRow({ run }: { run: RunView }): preact.JSX.Element {
  return (
    <tr>
      <td>
        <a href={`#/runs/${run.id}`}>
          <span class="badge" data-state={run.state}>
            {run.state}
          </span>
        </a>
      </td>
      <td data-label="Agent">{run.agentId}</td>
      <td data-label="Model">{run.model ?? "-"}</td>
      <td data-label="Tokens in / out">
        {run.inputTokens} / {run.outputTokens}
      </td>
      <td data-label="Duration">{fmtDuration(run.startedAt, run.endedAt)}</td>
      <td data-label="Started">{fmtTime(run.startedAt ?? run.createdAt)}</td>
    </tr>
  );
}

export function RunsPage(): preact.JSX.Element {
  const runs = useLoad(() => api("/api/runs", listSchema), []);
  useTopic("runs", runs.reload);
  return (
    <>
      <h2>Runs</h2>
      <StartForm onStarted={runs.reload} />
      {runs.error && <p class="error">{runs.error}</p>}
      {runs.data?.length === 0 && <p class="muted">No runs yet.</p>}
      {runs.data && runs.data.length > 0 && (
        <table class="stack">
          <thead>
            <tr>
              <th>State</th>
              <th>Agent</th>
              <th>Model</th>
              <th>Tokens in / out</th>
              <th>Duration</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {runs.data.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
