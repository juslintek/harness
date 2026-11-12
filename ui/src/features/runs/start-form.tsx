import { agentRowSchema } from "@shared/runs";
import { createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { Button, Field, Panel } from "../../ui/primitives";

const agentsSchema = z.array(agentRowSchema);
const startedSchema = z.object({ id: z.string() });

export function StartForm(props: { onStarted: () => void }): JSX.Element {
  const agents = createLoad("/api/agents", agentsSchema);
  const [agentId, setAgentId] = createSignal("");
  const [repo, setRepo] = createSignal("");
  const [model, setModel] = createSignal("");
  const [prompt, setPrompt] = createSignal("");
  const start = createAction();
  const listId = createUniqueId();
  const usable = () => (agents.data() ?? []).filter((a) => a.enabled && a.installed);
  const chosen = () => usable().find((a) => a.id === agentId());
  const submit = (e: SubmitEvent): void => {
    e.preventDefault();
    void start.run(async () => {
      const body = {
        agentId: agentId(),
        repo: repo(),
        prompt: prompt(),
        ...(model() ? { model: model() } : {}),
      };
      const { id } = await api("/api/runs", startedSchema, { method: "POST", body });
      setPrompt("");
      props.onStarted();
      location.hash = `#/runs/${id}`;
    });
  };
  return (
    <Panel title="Start a run">
      <form class="start-form" onSubmit={submit}>
        <Field label="Agent">
          {(control) => (
            <select {...control()} required onChange={(e) => setAgentId(e.currentTarget.value)}>
              <option value="">Choose an agent</option>
              <For each={usable()}>{(a) => <option value={a.id}>{a.name}</option>}</For>
            </select>
          )}
        </Field>
        <Show when={agents.data() && usable().length === 0}>
          <p class="muted">No agent is linked and installed. Link one on the Agents page.</p>
        </Show>
        <Field label="Repository path">
          {(control) => (
            <input
              {...control()}
              value={repo()}
              required
              placeholder="/absolute/path/to/repo"
              onInput={(e) => setRepo(e.currentTarget.value)}
            />
          )}
        </Field>
        <Field label="Model">
          {(control) => (
            <>
              <input
                {...control()}
                value={model()}
                list={listId}
                placeholder="agent default"
                onInput={(e) => setModel(e.currentTarget.value)}
              />
              <datalist id={listId}>
                <For each={chosen()?.models ?? []}>
                  {(m) => <option value={m.id}>{m.name}</option>}
                </For>
              </datalist>
            </>
          )}
        </Field>
        <Field label="Prompt">
          {(control) => (
            <textarea
              {...control()}
              value={prompt()}
              required
              rows={4}
              maxLength={20000}
              onInput={(e) => setPrompt(e.currentTarget.value)}
            />
          )}
        </Field>
        <Button type="submit" tone="primary" disabled={start.busy()}>
          Start run
        </Button>
        <Show when={start.error()}>
          {(message) => (
            <p class="error" role="alert">
              {message()}
            </p>
          )}
        </Show>
      </form>
    </Panel>
  );
}
