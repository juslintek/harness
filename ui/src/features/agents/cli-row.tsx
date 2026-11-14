import type { AgentRow } from "@shared/runs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { createAction } from "../../ui/action";
import { Button, Help, StatusBadge, Switch } from "../../ui/atoms";

const okSchema = z.object({ ok: z.literal(true) });
const modelsSchema = z.object({ models: z.array(z.object({ id: z.string(), name: z.string() })) });
const loginSchema = z.object({ command: z.array(z.string()) });

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

function loginBadge(agent: AgentRow): { tone: "success" | "warning" | "neutral"; word: string } {
  if (agent.loggedIn === null) return { tone: "neutral", word: "login unknown" };
  return agent.loggedIn
    ? { tone: "success", word: "logged in" }
    : { tone: "warning", word: "not logged in" };
}

export function CliRow(props: { agent: AgentRow; reload: () => void }): JSX.Element {
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
      <td data-label="Installed">
        <Show
          when={props.agent.installed}
          fallback={<StatusBadge tone="neutral" value="not installed" />}
        >
          <StatusBadge tone="success" value="installed" />
        </Show>
      </td>
      <Show
        when={props.agent.installed}
        fallback={
          <>
            <td data-label="Version" class="mono">
              –
            </td>
            <td data-label="Login">Not available</td>
            <td data-label="Use for runs">-</td>
            <td data-label="Models">-</td>
            <td>
              <Help>Install it on the server, then press Check again.</Help>
            </td>
          </>
        }
      >
        <td data-label="Version" class="mono">
          {props.agent.version ?? "–"}
        </td>
        <td data-label="Login">
          <StatusBadge tone={loginBadge(props.agent).tone} value={loginBadge(props.agent).word} />
        </td>
        <td data-label="Use for runs">
          <span class="cli-switch">
            <Switch
              checked={props.agent.enabled}
              ariaLabel="Use for runs"
              onChange={(next) => void setLinked(next)}
              disabled={link.busy()}
            />
            <span aria-hidden="true">{props.agent.enabled ? "On" : "Off"}</span>
          </span>
        </td>
        <td data-label="Models" class="muted">
          <Show when={props.agent.models.length > 0} fallback="-">
            <details>
              <summary>{props.agent.models.length} models</summary>
              <ul class="cli-models">
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
        </td>
        <td>
          <div class="cli-actions">
            <Button
              size="sm"
              disabled={models.busy()}
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
                {props.agent.loggedIn ? "Log in again" : "Log in"}
              </Button>
            </Show>
          </div>
          <Show when={command()}>
            {(cmd) => (
              <p class="muted" role="status">
                Running <code>{cmd()}</code> in the background, finish it in the browser window it
                opens.
              </p>
            )}
          </Show>
          <Problem message={link.error() ?? models.error() ?? login.error()} />
        </td>
      </Show>
    </tr>
  );
}
