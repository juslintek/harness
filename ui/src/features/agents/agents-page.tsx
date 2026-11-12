import { type AgentRow, agentRowSchema, ollayaStatusSchema } from "@shared/runs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { TableBox } from "../../ui/data-table";
import { Button, State, StatusBadge, Switch } from "../../ui/primitives";
import "../runs/runs.css";
import "./agents.css";
import { KeyForm } from "./key-form";

const agentsSchema = z.array(agentRowSchema);
const okSchema = z.object({ ok: z.literal(true) });
const modelsSchema = z.object({ models: z.array(z.object({ id: z.string(), name: z.string() })) });
const loginSchema = z.object({ command: z.array(z.string()) });

const loginText = (agent: AgentRow): string =>
  agent.loggedIn === null ? "unknown" : agent.loggedIn ? "yes" : "no";

function Problem(props: { message: string | null }): JSX.Element {
  return (
    <Show when={props.message}>
      {(message) => (
        <p class="error" role="alert">
          {message()}
        </p>
      )}
    </Show>
  );
}

function AgentRowView(props: { agent: AgentRow; reload: () => void }): JSX.Element {
  const link = createAction();
  const models = createAction();
  const login = createAction();
  const [command, setCommand] = createSignal<string | null>(null);
  const setLinked = (enabled: boolean): Promise<void> =>
    link
      .run(async () => {
        await api(`/api/agents/${props.agent.id}/link`, okSchema, {
          method: "POST",
          body: { enabled },
        });
      })
      .then(props.reload);
  return (
    <tr>
      <th scope="row">{props.agent.name}</th>
      <td>{props.agent.installed ? "yes" : "no"}</td>
      <td class="mono">{props.agent.version ?? "-"}</td>
      <td>{loginText(props.agent)}</td>
      <td>
        <div class="agents-cell">
          <Switch
            checked={props.agent.enabled}
            label={props.agent.enabled ? "linked" : "not linked"}
            onChange={(next) => void setLinked(next)}
            disabled={link.busy()}
          />
          <Problem message={link.error()} />
        </div>
      </td>
      <td>
        <div class="agents-cell">
          <Show when={props.agent.models.length > 0}>
            <details>
              <summary>{props.agent.models.length} models</summary>
              <ul>
                <For each={props.agent.models}>
                  {(m) => (
                    <li>
                      <code>{m.id}</code>
                    </li>
                  )}
                </For>
              </ul>
            </details>
          </Show>
          <Button
            size="sm"
            disabled={models.busy() || !props.agent.installed}
            onClick={() =>
              void models.run(async () => {
                await api(`/api/agents/${props.agent.id}/models`, modelsSchema, {
                  method: "POST",
                  body: {},
                });
                props.reload();
              })
            }
          >
            {models.busy() ? "Refreshing..." : "Refresh models"}
          </Button>
          <Problem message={models.error()} />
        </div>
      </td>
      <td>
        <div class="agents-cell">
          <Show when={props.agent.canLogin}>
            <Button
              size="sm"
              disabled={login.busy()}
              onClick={() =>
                void login.run(async () => {
                  const out = await api(`/api/agents/${props.agent.id}/login`, loginSchema, {
                    method: "POST",
                    body: {},
                  });
                  setCommand(out.command.join(" "));
                })
              }
            >
              Log in
            </Button>
          </Show>
          <Show when={command()}>
            {(cmd) => (
              <p class="muted" role="status">
                Running <code>{cmd()}</code> in the background, finish it in the browser window it
                opens.
              </p>
            )}
          </Show>
          <Problem message={login.error()} />
        </div>
      </td>
    </tr>
  );
}

function OllayaStatus(): JSX.Element {
  const status = createLoad("/api/agents/ollaya", ollayaStatusSchema);
  return (
    <p class="agents-bar">
      <span class="muted">Ollaya (L2 guard)</span>
      <Show when={status.data()} fallback={<span>{status.error() ?? "checking"}</span>}>
        {(s) => (
          <>
            <StatusBadge tone={s().up ? "success" : "danger"} value={s().up ? "up" : "down"} />
            <Show when={s().version}>{(v) => <span class="mono">{v()}</span>}</Show>
          </>
        )}
      </Show>
    </p>
  );
}

export function AgentsPage(): JSX.Element {
  const agents = createLoad("/api/agents", agentsSchema);
  return (
    <div class="page-stack">
      <div class="agents-bar">
        <OllayaStatus />
        <span class="spacer" />
        <Button onClick={() => void agents.reload()}>Refresh</Button>
      </div>
      <Show when={agents.error()}>
        {(message) => (
          <State kind="error" message={message()} onRetry={() => void agents.reload()} />
        )}
      </Show>
      <Show when={agents.loading()}>
        <State kind="loading" message="Checking installed agents..." />
      </Show>
      <Show when={agents.data()}>
        {(rows) => (
          <TableBox label="Agents">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Installed</th>
                <th scope="col">Version</th>
                <th scope="col">Logged in</th>
                <th scope="col">Linked</th>
                <th scope="col">Models</th>
                <th scope="col">Login</th>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(agent) => <AgentRowView agent={agent} reload={() => void agents.reload()} />}
              </For>
            </tbody>
          </TableBox>
        )}
      </Show>
      <KeyForm />
    </div>
  );
}
