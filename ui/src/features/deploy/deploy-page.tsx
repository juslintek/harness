import type { TargetView } from "@shared/distribution";
import { createEffect, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { me } from "../../auth/me";
import { minuteStamp } from "../../format";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { Button, Help, StatusBadge } from "../../ui/atoms";
import { CodeBlock, Field, Notice, Panel, State } from "../../ui/molecules";
import "../distribution/distribution.css";
import {
  type DeployRequestView,
  deployRequestSchema,
  deployRequestsSchema,
  deployTone,
  type PlanView,
  targetsSchema,
} from "./deploy-data";

const POLL_MS = 2000;
const shell = (cmds: string[][]): string => cmds.map((c) => c.join(" ")).join("\n");

function TargetRow(props: {
  target: TargetView;
  binary: string;
  port: string;
  onChange: (message: string) => void;
}): JSX.Element {
  const action = createAction();
  const request = (): void => {
    void action.run(async () => {
      const port = Number(props.port);
      await api("/api/deploy/requests", deployRequestSchema, {
        method: "POST",
        body: {
          targetId: props.target.id,
          binary: props.binary.trim(),
          ...(port > 0 && { port }),
        },
      });
      props.onChange(`Deploy request for ${props.target.name} created, review the steps below`);
    });
  };
  const addr = (): string =>
    `${props.target.user ? `${props.target.user}@` : ""}${props.target.address}${props.target.port ? `:${props.target.port}` : ""}`;
  return (
    <li class="dist-line">
      <div>
        <div class="dist-inline">
          <strong>{props.target.name}</strong>
          <StatusBadge tone="neutral" value={props.target.kind} />
        </div>
        <Help small>
          {addr()}
          {props.target.note ? ` · ${props.target.note}` : ""}
        </Help>
        <ErrorLine message={action.error()} />
      </div>
      <Show when={props.target.kind !== "docker"} fallback={<Help small>Not supported yet</Help>}>
        <Button
          size="sm"
          tone="secondary"
          disabled={action.busy()}
          aria-label={`Request deploy to ${props.target.name}`}
          onClick={request}
        >
          Request deploy
        </Button>
      </Show>
    </li>
  );
}

function PlanSteps(props: { plan: PlanView }): JSX.Element {
  const copyText = (): string =>
    `${props.plan.copy.from}\n-> ${props.plan.copy.to} (mode ${props.plan.copy.mode})`;
  return (
    <div class="dist-plan">
      <h3>Binary copy</h3>
      <CodeBlock label="Binary copy" text={copyText()} />
      <h3>Pairing code file</h3>
      <CodeBlock
        label="Pairing code file"
        text={`${props.plan.invite.path} (mode ${props.plan.invite.mode})\n${props.plan.invite.note}`}
      />
      <h3>Linux unit file</h3>
      <CodeBlock
        label="Linux unit file"
        text={`${props.plan.unit.linux.path}\n\n${props.plan.unit.linux.text}`}
      />
      <h3>Linux commands</h3>
      <CodeBlock label="Linux commands" text={shell(props.plan.commands.linux)} />
      <h3>macOS unit file</h3>
      <CodeBlock
        label="macOS unit file"
        text={`${props.plan.unit.darwin.path}\n\n${props.plan.unit.darwin.text}`}
      />
      <h3>macOS commands</h3>
      <CodeBlock label="macOS commands" text={shell(props.plan.commands.darwin)} />
      <h3>Health check</h3>
      <CodeBlock label="Health check" text={props.plan.health} />
      <Help small>{props.plan.pairing}</Help>
    </div>
  );
}

function RequestPanel(props: {
  request: DeployRequestView;
  onChange: (message: string) => void;
}): JSX.Element {
  const action = createAction();
  const base = `/api/deploy/requests/${encodeURIComponent(props.request.id)}`;

  const decide = (decision: "approve" | "deny"): void => {
    void action.run(async () => {
      await api(`${base}/decide`, deployRequestSchema, { method: "POST", body: { decision } });
      props.onChange(
        `${decision === "approve" ? "Approved" : "Denied"} deploy to ${props.request.target.name}`,
      );
    });
  };

  const run = (): void => {
    void action.run(async () => {
      await api(`${base}/run`, deployRequestSchema, { method: "POST" });
      props.onChange(`Deploy to ${props.request.target.name} started`);
    });
  };

  return (
    <Panel
      title={`${props.request.target.name} (${props.request.target.kind}, port ${props.request.port})`}
      actions={<StatusBadge tone={deployTone(props.request.status)} value={props.request.status} />}
    >
      <div class="dist-stack">
        <Help small>
          Requested {minuteStamp(props.request.createdAt)}, binary sha256{" "}
          <code>{props.request.binarySha256}</code>
        </Help>
        <PlanSteps plan={props.request.steps} />
        <Show when={props.request.status === "pending"}>
          <div class="dist-inline">
            <Button tone="primary" disabled={action.busy()} onClick={() => decide("approve")}>
              Approve (passkey)
            </Button>
            <Button tone="danger-quiet" disabled={action.busy()} onClick={() => decide("deny")}>
              Deny
            </Button>
          </div>
        </Show>
        <Show when={props.request.status === "approved"}>
          <div class="dist-inline">
            <Button tone="primary" disabled={action.busy()} onClick={run}>
              Run deploy
            </Button>
          </div>
        </Show>
        <ErrorLine message={action.error()} />
        <Show
          when={
            (props.request.status === "done" || props.request.status === "failed") &&
            props.request.result != null
          }
        >
          <CodeBlock
            label="Deploy result"
            text={JSON.stringify(props.request.result, null, 2)}
            copy={false}
          />
        </Show>
      </div>
    </Panel>
  );
}

function DeployBody(): JSX.Element {
  const [status, setStatus] = createSignal<string | null>(null);
  const [binary, setBinary] = createSignal("harness");
  const [port, setPort] = createSignal("4100");
  const targets = createLoad("/api/deploy/targets", targetsSchema);
  const requests = createLoad("/api/deploy/requests", deployRequestsSchema);

  createEffect(() => {
    const live = requests.data()?.some((r) => r.status === "approved" || r.status === "running");
    if (!live) return;
    const timer = setInterval(() => void requests.reload(), POLL_MS);
    onCleanup(() => clearInterval(timer));
  });

  const changed = (message: string): void => {
    setStatus(message);
    void requests.reload();
  };

  return (
    <div class="dist-page">
      <h1>Deploy</h1>
      <Help>
        Only the harness binary and a small unit file are copied to the new machine. No login, key,
        database or secret leaves this instance, and the new machine asks you to log in to agents
        there.
      </Help>
      <Show when={status()}>
        {(msg) => (
          <Notice tone="success" title="Updated">
            {msg()}
          </Notice>
        )}
      </Show>
      <ErrorLine message={targets.error() ?? requests.error()} />
      <Panel title="Targets">
        <div class="dist-stack">
          <div class="dist-row">
            <Field label="Binary file name (in the dist folder)">
              {(ctrl) => (
                <input
                  {...ctrl()}
                  value={binary()}
                  required
                  maxLength={300}
                  onInput={(e) => setBinary(e.currentTarget.value)}
                />
              )}
            </Field>
            <Field label="Port on the new machine">
              {(ctrl) => (
                <input
                  {...ctrl()}
                  type="number"
                  min={1}
                  max={65535}
                  value={port()}
                  onInput={(e) => setPort(e.currentTarget.value)}
                />
              )}
            </Field>
          </div>
          <Show
            when={(targets.data() ?? []).length > 0}
            fallback={<Help small>No ssh, tailscale or docker target found.</Help>}
          >
            <ul class="dist-list">
              <For each={targets.data() ?? []}>
                {(t) => <TargetRow target={t} binary={binary()} port={port()} onChange={changed} />}
              </For>
            </ul>
          </Show>
        </div>
      </Panel>
      <Show
        when={(requests.data() ?? []).length > 0}
        fallback={
          <Panel title="Requests">
            <Help small>No deploy requests yet.</Help>
          </Panel>
        }
      >
        <For each={requests.data() ?? []}>
          {(r) => <RequestPanel request={r} onChange={changed} />}
        </For>
      </Show>
    </div>
  );
}

export function DeployPage(): JSX.Element {
  return (
    <Show
      when={me()?.user.instanceAdmin === true}
      fallback={<State kind="empty" message="Not available." />}
    >
      <DeployBody />
    </Show>
  );
}
