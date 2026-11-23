import { useState } from "preact/hooks";
import { z } from "zod";
import { type AccountView, accountView } from "../../../shared/accounts";
import { routeDecisionViewSchema } from "../../../shared/router";
import {
  type AgentRow,
  agentRowSchema,
  ollayaStatusSchema,
  quotaRowSchema,
} from "../../../shared/runs";
import { api, useLoad } from "../../api";
import { errorText } from "../../format";
import { AccountsList } from "./accounts-list";
import { KeyForm } from "./key-form";
import { PoolPanel } from "./pool-panel";

const agentsSchema = z.array(agentRowSchema);
const accountsSchema = z.array(accountView);
const quotaListSchema = z.array(quotaRowSchema);
const decisionsSchema = z.array(routeDecisionViewSchema);
const okSchema = z.object({ ok: z.literal(true) });
const modelsSchema = z.object({ models: z.array(z.object({ id: z.string(), name: z.string() })) });
const loginSchema = z.object({ command: z.array(z.string()) });

function agentLoginText(agent: AgentRow): string {
  if (agent.loggedIn === null) return "unknown";
  return agent.loggedIn ? "yes" : "no";
}

function ModelsCell({
  agent,
  reload,
}: {
  agent: AgentRow;
  reload: () => void;
}): preact.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/agents/${agent.id}/models`, modelsSchema, { method: "POST", body: {} });
      reload();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {agent.models.length > 0 && (
        <details>
          <summary>{agent.models.length} models</summary>
          <ul class="plain">
            {agent.models.map((m) => (
              <li key={m.id}>
                <code>{m.id}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      <button type="button" disabled={busy || !agent.installed} onClick={refresh}>
        {busy ? "Refreshing..." : "Refresh models"}
      </button>
      {message && (
        <p class="error" role="alert">
          {message}
        </p>
      )}
    </>
  );
}

function AgentRowView({
  agent,
  reload,
}: {
  agent: AgentRow;
  reload: () => void;
}): preact.JSX.Element {
  const [command, setCommand] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const link = async (enabled: boolean): Promise<void> => {
    try {
      await api(`/api/agents/${agent.id}/link`, okSchema, { method: "POST", body: { enabled } });
    } catch (err) {
      setMessage(errorText(err));
    }
    reload();
  };
  const login = async (): Promise<void> => {
    try {
      const out = await api(`/api/agents/${agent.id}/login`, loginSchema, {
        method: "POST",
        body: {},
      });
      setCommand(out.command.join(" "));
    } catch (err) {
      setMessage(errorText(err));
    }
  };
  return (
    <tr>
      <th scope="row">{agent.name}</th>
      <td data-label="Installed">{agent.installed ? "yes" : "no"}</td>
      <td data-label="Version">{agent.version ?? "-"}</td>
      <td data-label="Logged in">{agentLoginText(agent)}</td>
      <td data-label="Linked">
        <label class="inline">
          <input
            type="checkbox"
            role="switch"
            aria-checked={agent.enabled}
            checked={agent.enabled}
            onChange={(e) => link(e.currentTarget.checked)}
          />
          {agent.enabled ? "linked" : "not linked"}
        </label>
      </td>
      <td data-label="Models">
        <ModelsCell agent={agent} reload={reload} />
      </td>
      <td data-label="Login">
        {agent.canLogin && (
          <button type="button" onClick={login}>
            Log in
          </button>
        )}
        {command && (
          <p class="muted">
            Running <code>{command}</code> in the background, finish it in the browser window it
            opens.
          </p>
        )}
        {message && (
          <p class="error" role="alert">
            {message}
          </p>
        )}
      </td>
    </tr>
  );
}

function OllayaStatus(): preact.JSX.Element {
  const status = useLoad(() => api("/api/agents/ollaya", ollayaStatusSchema), []);
  return (
    <p>
      Ollaya (L2 guard):{" "}
      {status.data ? (status.data.up ? `up ${status.data.version ?? ""}` : "down") : "checking"}
    </p>
  );
}

function RuntimeAccountsSection({
  agents,
  reloadAll,
  version,
}: {
  agents: AgentRow[];
  reloadAll: () => void;
  version: number;
}): preact.JSX.Element {
  const pool = useLoad(async () => {
    const entries = await Promise.all(
      agents.map(
        async (a) => [a.id, await api(`/api/agents/${a.id}/accounts`, accountsSchema)] as const,
      ),
    );
    const [quota, decisions] = await Promise.all([
      api("/api/quota", quotaListSchema),
      api("/api/router/decisions?limit=5", decisionsSchema),
    ]);
    return {
      accountsByRuntime: Object.fromEntries(entries) as Record<string, AccountView[]>,
      quota,
      decisions,
    };
  }, [agents.map((a) => a.id).join(","), version]);

  if (!pool.data)
    return pool.error ? (
      <p class="error">{pool.error}</p>
    ) : (
      <p class="muted">Loading accounts...</p>
    );
  const { accountsByRuntime, quota, decisions } = pool.data;
  const visible = agents.filter(
    (a) =>
      a.installed || (accountsByRuntime[a.id]?.some((acct) => acct.state !== "removed") ?? false),
  );
  return (
    <>
      <PoolPanel
        agents={agents}
        accountsByRuntime={accountsByRuntime}
        quota={quota}
        decisions={decisions}
      />
      <h3>Accounts by Runtime</h3>
      {visible.map((a) => (
        <AccountsList
          key={a.id}
          runtime={a.id}
          accounts={accountsByRuntime[a.id] ?? []}
          quota={quota}
          reload={() => {
            pool.reload();
            reloadAll();
          }}
        />
      ))}
    </>
  );
}

export function AgentsPage(): preact.JSX.Element {
  const agents = useLoad(() => api("/api/agents", agentsSchema), []);
  const [version, setVersion] = useState(0);
  const refreshAll = (): void => {
    setVersion((v) => v + 1);
    agents.reload();
  };
  return (
    <>
      <h2>Agents</h2>
      <button type="button" onClick={refreshAll}>
        Refresh
      </button>
      {agents.error && <p class="error">{agents.error}</p>}
      {!(agents.data || agents.error) && <p class="muted">Checking installed agents...</p>}
      {agents.data && (
        <>
          <table class="stack">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Installed</th>
                <th>Version</th>
                <th>Logged in</th>
                <th>Linked</th>
                <th>Models</th>
                <th>Login</th>
              </tr>
            </thead>
            <tbody>
              {agents.data.map((a) => (
                <AgentRowView key={a.id} agent={a} reload={refreshAll} />
              ))}
            </tbody>
          </table>
          <RuntimeAccountsSection agents={agents.data} reloadAll={refreshAll} version={version} />
        </>
      )}
      <OllayaStatus />
      <KeyForm />
    </>
  );
}
