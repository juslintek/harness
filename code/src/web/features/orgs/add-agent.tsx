import { useState } from "preact/hooks";
import { z } from "zod";
import type { OrgDetail } from "../../../shared/orgs";
import { agentRowSchema } from "../../../shared/runs";
import { api, useLoad } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { ignored } from "../auth/me";
import { useAction } from "../auth/use-action";

const SPECIALTIES = ["frontend", "backend", "database", "devops", "security", "writing", "mobile"];

// The runtime list is instance-admin only; without it the field is still a plain text input.
function RuntimeField({
  value,
  onInput,
}: {
  value: string;
  onInput: (v: string) => void;
}): preact.JSX.Element {
  const agents = useLoad(() => api("/api/agents", z.array(agentRowSchema)), []);
  const usable = agents.data?.filter((a) => a.installed && a.enabled) ?? [];
  return (
    <label>
      Runtime
      <input
        value={value}
        required
        list="runtime-ids"
        placeholder="runtime id, e.g. claude"
        onInput={(e) => onInput(e.currentTarget.value)}
      />
      <datalist id="runtime-ids">
        {usable.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </datalist>
    </label>
  );
}

export function AddAgent({
  detail,
  onChange,
}: {
  detail: OrgDetail;
  onChange: () => void;
}): preact.JSX.Element {
  const [agentId, setAgentId] = useState("");
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [model, setModel] = useState("");
  const [heartbeat, setHeartbeat] = useState("");
  const [specialties, setSpecialties] = useState<string[]>([]);
  const action = useAction();
  const toggle = (s: string, on: boolean): void =>
    setSpecialties((cur) => (on ? [...cur, s] : cur.filter((x) => x !== s)));
  const submit = (e: Event): void => {
    e.preventDefault();
    const body = {
      agentId,
      handle,
      displayName: displayName || handle,
      specialties,
      ...(model && { model }),
      ...(heartbeat && { heartbeatMinutes: Number(heartbeat) }),
    };
    action
      .run(async () => {
        await api(`/api/orgs/${detail.org.slug}/members/agents`, ignored, { method: "POST", body });
        setHandle("");
        setDisplayName("");
        onChange();
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <form onSubmit={submit}>
      <h4>Add agent</h4>
      <div class="row">
        <RuntimeField value={agentId} onInput={setAgentId} />
        <label>
          Model
          <input value={model} onInput={(e) => setModel(e.currentTarget.value)} />
        </label>
        <label>
          Handle
          <input
            value={handle}
            required
            pattern="[a-z0-9][a-z0-9_\-]{1,31}"
            onInput={(e) => setHandle(e.currentTarget.value)}
          />
        </label>
        <label>
          Display name
          <input value={displayName} onInput={(e) => setDisplayName(e.currentTarget.value)} />
        </label>
        <label>
          Heartbeat (minutes)
          <input
            type="number"
            min={1}
            value={heartbeat}
            onInput={(e) => setHeartbeat(e.currentTarget.value)}
          />
        </label>
      </div>
      <fieldset class="specialties">
        <legend>Specialties</legend>
        {SPECIALTIES.map((s) => (
          <label key={s} class="inline">
            <input
              type="checkbox"
              checked={specialties.includes(s)}
              onChange={(e) => toggle(s, e.currentTarget.checked)}
            />
            {s}
          </label>
        ))}
      </fieldset>
      <button type="submit" disabled={action.busy}>
        Add agent
      </button>
      <ErrorLine message={action.error} />
    </form>
  );
}
