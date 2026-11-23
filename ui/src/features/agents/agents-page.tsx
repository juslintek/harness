import { type AccountView, accountView } from "@shared/accounts";
import { routeDecisionViewSchema } from "@shared/router";
import { type AgentRow, agentRowSchema, ollayaStatusSchema, quotaRowSchema } from "@shared/runs";
import { createResource, createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { createLoad } from "../../load";
import { Button, Help, StatusBadge } from "../../ui/atoms";
import { Notice, State, TableBox } from "../../ui/molecules";
import "../runs/runs.css";
import "./agents.css";
import { RuntimeAccountsPanel } from "./accounts-section";
import { CliRow } from "./cli-row";
import { KeyForm } from "./key-form";
import { PoolPanel } from "./pool-panel";

const agentsSchema = z.array(agentRowSchema);
const accountsSchema = z.array(accountView);
const quotaListSchema = z.array(quotaRowSchema);
const decisionsSchema = z.array(routeDecisionViewSchema);

function OllayaStatus(): JSX.Element {
  const status = createLoad("/api/agents/ollaya", ollayaStatusSchema);
  return (
    <p class="agents-bar">
      <span class="muted">Guard model (layer 2):</span>
      <span>Ollaya</span>
      <Show when={status.data()} fallback={<span>{status.error() ?? "checking"}</span>}>
        {(s) => (
          <>
            <Show when={s().version}>{(v) => <span class="mono">{v()}</span>}</Show>
            <StatusBadge tone={s().up ? "success" : "danger"} value={s().up ? "up" : "down"} />
          </>
        )}
      </Show>
    </p>
  );
}

function AccountsArea(props: {
  agents: AgentRow[];
  tick: number;
  reloadAll: () => void;
}): JSX.Element {
  const [pool, { refetch }] = createResource(
    () => ({ ids: props.agents.map((a) => a.id), tick: props.tick }),
    async ({ ids }) => {
      const entries = await Promise.all(
        ids.map(
          async (id) => [id, await api(`/api/agents/${id}/accounts`, accountsSchema)] as const,
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
    },
  );
  const reload = (): void => {
    void refetch();
    props.reloadAll();
  };
  return (
    <Show when={pool()}>
      {(data) => {
        const visible = () =>
          props.agents.filter(
            (a) => a.installed || (data().accountsByRuntime[a.id]?.length ?? 0) > 0,
          );
        return (
          <>
            <PoolPanel
              agents={props.agents}
              accountsByRuntime={data().accountsByRuntime}
              quota={data().quota}
              decisions={data().decisions}
            />
            <For each={visible()}>
              {(a) => (
                <RuntimeAccountsPanel
                  runtime={a.id}
                  accounts={data().accountsByRuntime[a.id] ?? []}
                  quota={data().quota}
                  reload={reload}
                />
              )}
            </For>
          </>
        );
      }}
    </Show>
  );
}

export function AgentsPage(): JSX.Element {
  const agents = createLoad("/api/agents", agentsSchema);
  const [tick, setTick] = createSignal(0);
  const reloadAll = (): void => {
    setTick((t) => t + 1);
    void agents.reload();
  };
  const none = (): boolean =>
    agents.data() !== undefined && !agents.data()?.some((a) => a.installed);
  return (
    <div class="page-stack agents-page">
      <Help>
        An agent CLI is a program installed on this server, such as Claude Code. An agent is a
        worker in your organisation, such as @claude-main, that uses one of these CLIs to do its
        work.
      </Help>
      <div class="agents-bar">
        <OllayaStatus />
        <span class="spacer" />
        <Show when={!none()}>
          <Button onClick={reloadAll}>Check again</Button>
        </Show>
      </div>
      <Show when={none()}>
        <Notice
          tone="warning"
          title="No CLI is installed"
          actions={
            <Button tone="primary" onClick={reloadAll}>
              Check again
            </Button>
          }
        >
          Install a CLI on the server, then press Check again.
        </Notice>
      </Show>
      <Show when={agents.error()}>
        {(message) => <State kind="error" message={message()} onRetry={reloadAll} />}
      </Show>
      <Show when={agents.loading()}>
        <State kind="loading" message="Checking installed CLIs..." />
      </Show>
      <Show when={agents.data()}>
        {(rows) => (
          <>
            <TableBox stack label="Agent CLIs">
              <thead>
                <tr>
                  <th scope="col">CLI</th>
                  <th scope="col">Installed</th>
                  <th scope="col">Version</th>
                  <th scope="col">Login</th>
                  <th scope="col">Use for runs</th>
                  <th scope="col">Models</th>
                  <td />
                </tr>
              </thead>
              <tbody>
                <For each={rows()}>{(agent) => <CliRow agent={agent} reload={reloadAll} />}</For>
              </tbody>
            </TableBox>
            <AccountsArea agents={rows()} tick={tick()} reloadAll={reloadAll} />
          </>
        )}
      </Show>
      <KeyForm />
    </div>
  );
}
