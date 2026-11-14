import { agentRowSchema, ollayaStatusSchema } from "@shared/runs";
import { For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { createLoad } from "../../load";
import { Button, Help, StatusBadge } from "../../ui/atoms";
import { Notice, State, TableBox } from "../../ui/molecules";
import "../runs/runs.css";
import "./agents.css";
import { CliRow } from "./cli-row";
import { KeyForm } from "./key-form";

const agentsSchema = z.array(agentRowSchema);

function OllayaStatus(): JSX.Element {
  const status = createLoad("/api/agents/ollaya", ollayaStatusSchema);
  return (
    <p class="agents-bar">
      <span class="muted">Guard model (layer 2):</span>
      <span>Ollaya</span>
      <Show when={status.data()} fallback={<span>{status.error() ?? "checking"}</span>}>
        {(s) => (
          <>
            <Show when={s().version}>{(v) => <span class="mono">{v()}</span>}</Show>
            <StatusBadge tone={s().up ? "success" : "danger"} value={s().up ? "up" : "down"} />
          </>
        )}
      </Show>
    </p>
  );
}

export function AgentsPage(): JSX.Element {
  const agents = createLoad("/api/agents", agentsSchema);
  const none = (): boolean =>
    agents.data() !== undefined && !agents.data()?.some((a) => a.installed);
  return (
    <div class="page-stack agents-page">
      <Help>
        An agent CLI is a program installed on this server, such as Claude Code. An agent is a
        worker in your organisation, such as @claude-main, that uses one of these CLIs to do its
        work.
      </Help>
      <div class="agents-bar">
        <OllayaStatus />
        <span class="spacer" />
        <Show when={!none()}>
          <Button onClick={() => void agents.reload()}>Check again</Button>
        </Show>
      </div>
      <Show when={none()}>
        <Notice
          tone="warning"
          title="No CLI is installed"
          actions={
            <Button tone="primary" onClick={() => void agents.reload()}>
              Check again
            </Button>
          }
        >
          Install a CLI on the server, then press Check again.
        </Notice>
      </Show>
      <Show when={agents.error()}>
        {(message) => (
          <State kind="error" message={message()} onRetry={() => void agents.reload()} />
        )}
      </Show>
      <Show when={agents.loading()}>
        <State kind="loading" message="Checking installed CLIs..." />
      </Show>
      <Show when={agents.data()}>
        {(rows) => (
          <TableBox stack label="Agent CLIs">
            <thead>
              <tr>
                <th scope="col">CLI</th>
                <th scope="col">Installed</th>
                <th scope="col">Version</th>
                <th scope="col">Login</th>
                <th scope="col">Use for runs</th>
                <th scope="col">Models</th>
                <td />
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(agent) => <CliRow agent={agent} reload={() => void agents.reload()} />}
              </For>
            </tbody>
          </TableBox>
        )}
      </Show>
      <KeyForm />
    </div>
  );
}
