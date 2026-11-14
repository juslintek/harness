import { type HireView, hireViewSchema, type RoleSpec } from "@shared/hiring";
import type { OrgDetail } from "@shared/orgs";
import { type Specialty, specialties, type TaskType, taskTypes } from "@shared/router";
import { createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { routeQuery } from "../../route";
import { createAction } from "../../ui/action";
import { Button, Help } from "../../ui/atoms";
import { Field, Notice, Panel } from "../../ui/molecules";
import { FormError } from "../orgs/shared";

const MAX_TASK_TYPES = 4;

// A deep link can preselect the specialty (#/o/acme/hiring?specialty=writing); anything else is ignored.
export const specialtyFromLink = (): Specialty | undefined =>
  specialties.find((s) => s === routeQuery().get("specialty"));

export function NewHire(props: { detail: OrgDetail; onFiled: () => void }): JSX.Element {
  const [teamId, setTeamId] = createSignal(props.detail.teams[0]?.id ?? "");
  const [title, setTitle] = createSignal("");
  const [specialty, setSpecialty] = createSignal<Specialty>(specialtyFromLink() ?? "backend");
  const [maxCandidates, setMaxCandidates] = createSignal(2);
  const [summary, setSummary] = createSignal("");
  const [mustHave, setMustHave] = createSignal("");
  const [types, setTypes] = createSignal<TaskType[]>(["feature"]);
  const [filed, setFiled] = createSignal<HireView | null>(null);
  const action = createAction();
  const toggle = (t: TaskType, on: boolean): void => {
    setTypes(on ? [...types(), t] : types().filter((x) => x !== t));
  };
  const submit = (e: Event): void => {
    e.preventDefault();
    const spec: RoleSpec = {
      title: title(),
      specialty: specialty(),
      summary: summary(),
      mustHave: mustHave()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      taskTypes: types(),
    };
    void action.run(async () => {
      const hire = await api(`/api/orgs/${props.detail.org.slug}/hires`, hireViewSchema, {
        method: "POST",
        body: { teamId: teamId(), spec, maxCandidates: maxCandidates() },
      });
      setFiled(hire);
      setTitle("");
      setSummary("");
      setMustHave("");
      props.onFiled();
    });
  };
  return (
    <Panel title="New hire">
      <form class="stack" onSubmit={submit}>
        <Show when={props.detail.teams.length === 0}>
          <Notice tone="warning" standing>
            This organisation has no team yet. Create a team in Settings first.
          </Notice>
        </Show>
        <div class="form-row">
          <Field label="Team">
            {(c) => (
              <select {...c()} required onChange={(e) => setTeamId(e.currentTarget.value)}>
                <For each={props.detail.teams}>
                  {(t) => (
                    <option value={t.id} selected={t.id === teamId()}>
                      {t.name}
                    </option>
                  )}
                </For>
              </select>
            )}
          </Field>
          <Field label="Role title">
            {(c) => (
              <input
                {...c()}
                value={title()}
                required
                maxLength={60}
                onInput={(e) => setTitle(e.currentTarget.value)}
              />
            )}
          </Field>
          <Field label="Specialty">
            {(c) => (
              <select {...c()} onChange={(e) => setSpecialty(e.currentTarget.value as Specialty)}>
                <For each={specialties}>
                  {(s) => (
                    <option value={s} selected={s === specialty()}>
                      {s}
                    </option>
                  )}
                </For>
              </select>
            )}
          </Field>
          <Field label="Candidates to interview">
            {(c) => (
              <select {...c()} onChange={(e) => setMaxCandidates(Number(e.currentTarget.value))}>
                <For each={[1, 2, 3]}>
                  {(n) => (
                    <option value={n} selected={n === maxCandidates()}>
                      {n}
                    </option>
                  )}
                </For>
              </select>
            )}
          </Field>
        </div>
        <Field label="What the role does">
          {(c) => (
            <textarea
              {...c()}
              value={summary()}
              required
              maxLength={500}
              rows={3}
              onInput={(e) => setSummary(e.currentTarget.value)}
            />
          )}
        </Field>
        <Field label="Must-haves, one per line, up to 6">
          {(c) => (
            <textarea
              {...c()}
              value={mustHave()}
              rows={3}
              onInput={(e) => setMustHave(e.currentTarget.value)}
            />
          )}
        </Field>
        <fieldset class="checks">
          <legend class="sub-title">Task types, 1 to {MAX_TASK_TYPES}</legend>
          <For each={taskTypes}>
            {(t) => (
              <label class="check">
                <input
                  type="checkbox"
                  checked={types().includes(t)}
                  disabled={!types().includes(t) && types().length >= MAX_TASK_TYPES}
                  onChange={(e) => toggle(t, e.currentTarget.checked)}
                />
                {t}
              </label>
            )}
          </For>
        </fieldset>
        <Notice tone="info" title="After you file the request">
          Harness picks up to {maxCandidates()} candidate runtimes that your Allowed runtimes policy
          permits. Each one is interviewed in a real agent run charged to you. Team agents may ask
          follow-ups, reviewers score the candidates, and then you decide. The request shows under
          Requests with its step.
        </Notice>
        <div class="form-row form-submit">
          <Button
            type="submit"
            tone="primary"
            disabled={action.busy() || types().length === 0 || !teamId()}
          >
            File request
          </Button>
          <Help>
            Limits: one open request per team, 3 per organisation in 24 hours. A paused budget of
            yours blocks new requests.
          </Help>
        </div>
        <FormError message={action.error()} />
        <Show when={filed()}>
          {(hire) => (
            <Notice tone="success" title="Request filed">
              <a class="hire-link" href={`#/o/${props.detail.org.slug}/hiring/${hire().id}`}>
                Open {hire().spec.title}
              </a>{" "}
              to follow it.
            </Notice>
          )}
        </Show>
      </form>
    </Panel>
  );
}
