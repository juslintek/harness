import { useState } from "preact/hooks";
import type { OrgDetail } from "../../../shared/orgs";
import { type Specialty, specialties, type TaskType, taskTypes } from "../../../shared/router";
import { api } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { ignored } from "../auth/me";
import { useAction } from "../auth/use-action";

const MAX_TASK_TYPES = 4;

function TaskTypes({
  value,
  onChange,
}: {
  value: TaskType[];
  onChange: (next: TaskType[]) => void;
}): preact.JSX.Element {
  return (
    <fieldset class="checks">
      <legend>Task types (1 to {MAX_TASK_TYPES})</legend>
      {taskTypes.map((t) => (
        <label key={t} class="inline">
          <input
            type="checkbox"
            checked={value.includes(t)}
            disabled={!value.includes(t) && value.length >= MAX_TASK_TYPES}
            onChange={(e) =>
              onChange(e.currentTarget.checked ? [...value, t] : value.filter((x) => x !== t))
            }
          />
          {t}
        </label>
      ))}
    </fieldset>
  );
}

interface Basics {
  teamId: string;
  title: string;
  specialty: Specialty;
  maxCandidates: number;
}

function BasicFields({
  value,
  teams,
  onChange,
}: {
  value: Basics;
  teams: OrgDetail["teams"];
  onChange: (next: Basics) => void;
}): preact.JSX.Element {
  return (
    <div class="row">
      <label>
        Team
        <select
          value={value.teamId}
          required
          onChange={(e) => onChange({ ...value, teamId: e.currentTarget.value })}
        >
          {teams.map((t) => (
            <option key={t.id} value={t.id} label={t.name} />
          ))}
        </select>
      </label>
      <label>
        Title
        <input
          value={value.title}
          required
          maxLength={60}
          onInput={(e) => onChange({ ...value, title: e.currentTarget.value })}
        />
      </label>
      <label>
        Specialty
        <select
          value={value.specialty}
          onChange={(e) => onChange({ ...value, specialty: e.currentTarget.value as Specialty })}
        >
          {specialties.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label>
        Candidates
        <select
          value={value.maxCandidates}
          onChange={(e) => onChange({ ...value, maxCandidates: Number(e.currentTarget.value) })}
        >
          {[1, 2, 3].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function NewHire({
  detail,
  onFiled,
}: {
  detail: OrgDetail;
  onFiled: () => void;
}): preact.JSX.Element {
  const [basics, setBasics] = useState<Basics>({
    teamId: detail.teams[0]?.id ?? "",
    title: "",
    specialty: "backend",
    maxCandidates: 2,
  });
  const [summary, setSummary] = useState("");
  const [mustHave, setMustHave] = useState("");
  const [types, setTypes] = useState<TaskType[]>(["feature"]);
  const action = useAction();
  const submit = (e: Event): void => {
    e.preventDefault();
    const { teamId, maxCandidates, title, specialty } = basics;
    const spec = {
      title,
      specialty,
      summary,
      mustHave: mustHave
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      taskTypes: types,
    };
    action
      .run(async () => {
        await api(`/api/orgs/${detail.org.slug}/hires`, ignored, {
          method: "POST",
          body: { teamId, spec, maxCandidates },
        });
        setBasics({ ...basics, title: "" });
        setSummary("");
        setMustHave("");
        onFiled();
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <form class="card new-hire" onSubmit={submit}>
      <h3>New hire</h3>
      <BasicFields value={basics} teams={detail.teams} onChange={setBasics} />
      <label>
        Summary
        <textarea
          value={summary}
          required
          maxLength={500}
          rows={3}
          onInput={(e) => setSummary(e.currentTarget.value)}
        />
      </label>
      <label>
        Must-haves (one per line, up to 6)
        <textarea value={mustHave} rows={3} onInput={(e) => setMustHave(e.currentTarget.value)} />
      </label>
      <TaskTypes value={types} onChange={setTypes} />
      <button type="submit" disabled={action.busy || types.length === 0 || !basics.teamId}>
        File request
      </button>
      <ErrorLine message={action.error} />
    </form>
  );
}
