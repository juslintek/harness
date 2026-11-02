import { useState } from "preact/hooks";
import { z } from "zod";
import { agentRowSchema } from "../../../shared/runs";
import { api, useLoad } from "../../api";
import { errorText } from "../../format";

const agentsSchema = z.array(agentRowSchema);
const startedSchema = z.object({ id: z.string() });

export function StartForm({ onStarted }: { onStarted: () => void }): preact.JSX.Element {
  const agents = useLoad(() => api("/api/agents", agentsSchema), []);
  const [agentId, setAgentId] = useState("");
  const [repo, setRepo] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const usable = (agents.data ?? []).filter((a) => a.enabled && a.installed);
  const chosen = usable.find((a) => a.id === agentId);

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    setMessage(null);
    try {
      const body = { agentId, repo, prompt, ...(model ? { model } : {}) };
      const { id } = await api("/api/runs", startedSchema, { method: "POST", body });
      setPrompt("");
      onStarted();
      location.hash = `#/runs/${id}`;
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  return (
    <form class="card" onSubmit={submit}>
      <h3>Start a run</h3>
      <label>
        Agent
        <select value={agentId} required onChange={(e) => setAgentId(e.currentTarget.value)}>
          <option value="">Choose an agent</option>
          {usable.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      {agents.data && usable.length === 0 && (
        <p class="muted">No agent is linked and installed. Link one on the Agents page.</p>
      )}
      <label>
        Repository path
        <input
          value={repo}
          required
          placeholder="/absolute/path/to/repo"
          onInput={(e) => setRepo(e.currentTarget.value)}
        />
      </label>
      <label>
        Model
        <input
          value={model}
          list="saved-models"
          placeholder="agent default"
          onInput={(e) => setModel(e.currentTarget.value)}
        />
        <datalist id="saved-models">
          {(chosen?.models ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </datalist>
      </label>
      <label>
        Prompt
        <textarea
          value={prompt}
          required
          rows={4}
          maxLength={20000}
          onInput={(e) => setPrompt(e.currentTarget.value)}
        />
      </label>
      <button type="submit">Start run</button>
      {message && (
        <p class="error" role="alert">
          {message}
        </p>
      )}
    </form>
  );
}
