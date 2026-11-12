import type { RoleSpec } from "@shared/hiring";
import type { OrgDetail } from "@shared/orgs";
import { type Specialty, specialties, type TaskType, taskTypes } from "@shared/router";
import { createSignal, For, type JSX } from "solid-js";
import { api } from "../../api";
import { ignored } from "../../auth/me";
import { createAction } from "../../ui/action";
import { Button, Field, Panel } from "../../ui/primitives";
import { FormError } from "../orgs/shared";

const MAX_TASK_TYPES = 4;

export function NewHire(props: { detail: OrgDetail; onFiled: () => void }): JSX.Element {
  const [teamId, setTeamId] = createSignal(props.detail.teams[0]?.id ?? "");
  const [title, setTitle] = createSignal("");
  const [specialty, setSpecialty] = createSignal<Specialty>("backend");
  const [maxCandidates, setMaxCandidates] = createSignal(2);
  const [summary, setSummary] = createSignal("");
  const [mustHave, setMustHave] = createSignal("");
  const [types, setTypes] = createSignal<TaskType[]>(["feature"]);
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
      await api(`/api/orgs/${props.detail.org.slug}/hires`, ignored, {
        method: "POST",
        body: { teamId: teamId(), spec, maxCandidates: maxCandidates() },
      });
      setTitle("");
      setSummary("");
      setMustHave("");
      props.onFiled();
    });
  };
  return (
    <Panel title="New hire">
      <form class="stack" onSubmit={submit}>
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
          <Field label="Title">
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
          <Field label="Candidates">
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
        <Field label="Summary">
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
        <Field label="Must-haves (one per line, up to 6)">
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
          <legend class="sub-title">Task types (1 to {MAX_TASK_TYPES})</legend>
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
        <div>
          <Button
            type="submit"
            tone="primary"
            disabled={action.busy() || types().length === 0 || !teamId()}
          >
            File request
          </Button>
        </div>
        <FormError message={action.error()} />
      </form>
    </Panel>
  );
}
