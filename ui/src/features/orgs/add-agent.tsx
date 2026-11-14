import type { OrgDetail } from "@shared/orgs";
import { agentRowSchema } from "@shared/runs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { ignored } from "../../auth/me";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { Button, Help } from "../../ui/atoms";
import { Field, Notice } from "../../ui/molecules";
import { FormError } from "./shared";

const SPECIALTIES = ["frontend", "backend", "database", "devops", "security", "writing", "mobile"];

export function AddAgent(props: { detail: OrgDetail; onChange: () => void }): JSX.Element {
  const [agentId, setAgentId] = createSignal("");
  const [handle, setHandle] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");
  const [model, setModel] = createSignal("");
  const [heartbeat, setHeartbeat] = createSignal("");
  const [specialties, setSpecialties] = createSignal<string[]>([]);
  const [added, setAdded] = createSignal<string | null>(null);
  const action = createAction();
  // The runtime list is instance-admin only; without it the field is still a plain text input.
  const agents = createLoad("/api/agents", z.array(agentRowSchema));
  const usable = (): { id: string; name: string }[] =>
    agents.data()?.filter((a) => a.installed && a.enabled) ?? [];
  const toggle = (s: string, on: boolean): void => {
    setSpecialties((cur) => (on ? [...cur, s] : cur.filter((x) => x !== s)));
  };
  return (
    <form
      class="stack members-section"
      onSubmit={(e) => {
        e.preventDefault();
        setAdded(null);
        const body = {
          agentId: agentId(),
          handle: handle(),
          displayName: displayName() || handle(),
          specialties: specialties(),
          ...(model() && { model: model() }),
          ...(heartbeat() && { heartbeatMinutes: Number(heartbeat()) }),
        };
        void action.run(async () => {
          await api(`/api/orgs/${props.detail.org.slug}/members/agents`, ignored, {
            method: "POST",
            body,
          });
          setAdded(`Added @${handle()} to ${props.detail.org.name}.`);
          setHandle("");
          setDisplayName("");
          props.onChange();
        });
      }}
    >
      <h3 class="sub-title">Add agent directly</h3>
      <p class="muted">
        Use this to add an agent you already know. To find the right one for a job, use{" "}
        <a href={`#/o/${props.detail.org.slug}/hiring`}>Hiring</a>.
      </p>
      <div class="form-row">
        <Field label="Runtime">
          {(c) => (
            <>
              <input
                {...c()}
                value={agentId()}
                required
                list="runtime-ids"
                placeholder="runtime id, e.g. claude"
                onInput={(e) => setAgentId(e.currentTarget.value)}
              />
              <datalist id="runtime-ids">
                <For each={usable()}>{(a) => <option value={a.id}>{a.name}</option>}</For>
              </datalist>
            </>
          )}
        </Field>
        <Field label="Model">
          {(c) => (
            <input {...c()} value={model()} onInput={(e) => setModel(e.currentTarget.value)} />
          )}
        </Field>
        <Field label="Handle">
          {(c) => (
            <input
              {...c()}
              value={handle()}
              required
              pattern="[a-z0-9][a-z0-9_\-]{1,31}"
              onInput={(e) => setHandle(e.currentTarget.value)}
            />
          )}
        </Field>
        <Field label="Display name">
          {(c) => (
            <input
              {...c()}
              value={displayName()}
              onInput={(e) => setDisplayName(e.currentTarget.value)}
            />
          )}
        </Field>
        <Field label="Heartbeat (minutes)">
          {(c) => (
            <input
              {...c()}
              type="number"
              min={1}
              value={heartbeat()}
              onInput={(e) => setHeartbeat(e.currentTarget.value)}
            />
          )}
        </Field>
      </div>
      <Help small>Heartbeat is how often the agent looks for work on its own.</Help>
      <fieldset class="checks">
        <legend class="sub-title">Skills</legend>
        <For each={SPECIALTIES}>
          {(s) => (
            <label class="check">
              <input
                type="checkbox"
                checked={specialties().includes(s)}
                onChange={(e) => toggle(s, e.currentTarget.checked)}
              />
              {s}
            </label>
          )}
        </For>
      </fieldset>
      <div>
        <Button type="submit" disabled={action.busy()}>
          Add agent
        </Button>
      </div>
      <FormError message={action.error()} />
      <Show when={added()}>{(text) => <Notice tone="success">{text()}</Notice>}</Show>
    </form>
  );
}
