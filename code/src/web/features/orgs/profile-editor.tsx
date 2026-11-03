import { useState } from "preact/hooks";
import { z } from "zod";
import type { MemberView } from "../../../shared/orgs";
import type { ProfileInput, ProfileView } from "../../../shared/profiles";
import { agentRowSchema } from "../../../shared/runs";
import { api, useLoad } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { useAction } from "../auth/use-action";
import { CardEditor } from "./card-editor";
import { profileViewSchema } from "./profile-schema";

const MAX_FALLBACKS = 3;

const RUNTIME_LIST = "profile-runtime-ids";

function RuntimeInput({
  label,
  value,
  onInput,
}: {
  label: string;
  value: string;
  onInput: (v: string) => void;
}): preact.JSX.Element {
  return (
    <label>
      {label}
      <input
        value={value}
        required
        list={RUNTIME_LIST}
        onInput={(e) => onInput(e.currentTarget.value)}
      />
    </label>
  );
}

function Fallbacks({
  value,
  onChange,
}: {
  value: ProfileInput["fallbacks"];
  onChange: (next: ProfileInput["fallbacks"]) => void;
}): preact.JSX.Element {
  const set = (i: number, patch: Partial<ProfileInput["fallbacks"][number]>): void =>
    onChange(value.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <fieldset>
      <legend>Fallback engines (tried in order)</legend>
      {value.map((f, i) => (
        <div class="row" key={`${f.runtime}-${i}`}>
          <RuntimeInput
            label={`Fallback ${i + 1} runtime`}
            value={f.runtime}
            onInput={(v) => set(i, { runtime: v })}
          />
          <label>
            Fallback {i + 1} model
            <input
              value={f.model ?? ""}
              onInput={(e) => set(i, { model: e.currentTarget.value || null })}
            />
          </label>
          <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            Remove fallback {i + 1}
          </button>
        </div>
      ))}
      {value.length < MAX_FALLBACKS && (
        <button type="button" onClick={() => onChange([...value, { runtime: "", model: null }])}>
          Add fallback
        </button>
      )}
    </fieldset>
  );
}

function ProfileForm({
  url,
  profile,
  runtimes,
  onSaved,
}: {
  url: string;
  profile: ProfileInput;
  runtimes: { id: string; name: string }[];
  onSaved: () => void;
}): preact.JSX.Element {
  const [form, setForm] = useState<ProfileInput>(profile);
  const [skills, setSkills] = useState(profile.skills.join(", "));
  const action = useAction();
  const submit = (e: Event): void => {
    e.preventDefault();
    const body: ProfileInput = {
      ...form,
      skills: skills
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
    action
      .run(async () => {
        await api(url, profileViewSchema, { method: "PUT", body });
        onSaved();
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <form onSubmit={submit}>
      <datalist id={RUNTIME_LIST}>
        {runtimes.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </datalist>
      <div class="row">
        <RuntimeInput
          label="Runtime"
          value={form.runtime}
          onInput={(runtime) => setForm({ ...form, runtime })}
        />
        <label>
          Model
          <input
            value={form.model ?? ""}
            onInput={(e) => setForm({ ...form, model: e.currentTarget.value || null })}
          />
        </label>
      </div>
      <label>
        Persona
        <textarea
          rows={4}
          maxLength={2000}
          value={form.persona}
          onInput={(e) => setForm({ ...form, persona: e.currentTarget.value })}
        />
      </label>
      <label>
        Skills (comma separated)
        <input value={skills} onInput={(e) => setSkills(e.currentTarget.value)} />
      </label>
      <label class="inline">
        <input
          type="checkbox"
          checked={form.scope.readOnly}
          onChange={(e) => setForm({ ...form, scope: { readOnly: e.currentTarget.checked } })}
        />
        Read-only scope (the agent cannot write to the repository)
      </label>
      <Fallbacks value={form.fallbacks} onChange={(fallbacks) => setForm({ ...form, fallbacks })} />
      <button type="submit" disabled={action.busy}>
        Save profile
      </button>
      <ErrorLine message={action.error} />
    </form>
  );
}

export function ProfileEditor({
  slug,
  member,
}: {
  slug: string;
  member: MemberView;
}): preact.JSX.Element {
  const url = `/api/orgs/${slug}/members/${member.id}/profile`;
  const loaded = useLoad(() => api(url, profileViewSchema), [url]);
  // The runtime list is instance-admin only; without it the field is still a plain text input.
  const agents = useLoad(() => api("/api/agents", z.array(agentRowSchema)), []);
  const runtimes = agents.data?.filter((a) => a.installed && a.enabled) ?? [];
  const missing = loaded.error?.endsWith("not_found") === true;
  const profile: ProfileView | ProfileInput | null =
    loaded.data ??
    (missing
      ? {
          runtime: member.agentId ?? "",
          model: member.model,
          persona: "",
          skills: [],
          scope: { readOnly: false },
          fallbacks: [],
        }
      : null);
  if (!profile) return loaded.error ? <ErrorLine message={loaded.error} /> : <p>Loading...</p>;
  return (
    <section class="card profile-editor" aria-label={`Profile of @${member.handle}`}>
      <h4>Profile of @{member.handle}</h4>
      <ProfileForm
        key={loaded.data?.id ?? "new"}
        url={url}
        profile={profile}
        runtimes={runtimes}
        onSaved={loaded.reload}
      />
      <CardEditor
        key={loaded.data?.cardAt ?? "none"}
        url={`${url}/card`}
        card={loaded.data?.card ?? null}
        onSaved={loaded.reload}
      />
    </section>
  );
}
