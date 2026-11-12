import { createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { ignored } from "../../auth/me";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { Button, Field, Panel, StatusBadge } from "../../ui/primitives";
import {
  canConfirmStart,
  isPublicProvider,
  PROVIDERS,
  type Provider,
  startBody,
} from "./tunnel-logic";

const providerSchema = z.enum(["tailscale-serve", "tailscale-funnel", "cloudflare"]);
const command = z.object({ start: z.string(), stop: z.string().nullable() });
const infoSchema = z.object({
  detected: z.object({
    tailscale: z.object({ installed: z.boolean(), dnsName: z.string().nullable() }),
    cloudflared: z.object({ installed: z.boolean() }),
  }),
  config: z.object({ provider: providerSchema, origin: z.string().optional() }).nullable(),
  running: providerSchema.nullable(),
  commands: z.object({
    "tailscale-serve": command,
    "tailscale-funnel": command,
    cloudflare: command,
  }),
});
type TunnelInfo = z.infer<typeof infoSchema>;

const warningSchema = z.object({ warning: z.string() });

function Choice(props: { info: TunnelInfo; onSaved: (warning: string) => void }): JSX.Element {
  const [provider, setProvider] = createSignal<Provider>(
    props.info.config?.provider ?? "tailscale-serve",
  );
  const [hostname, setHostname] = createSignal(
    props.info.config?.origin?.replace("https://", "") ??
      props.info.detected.tailscale.dnsName ??
      "",
  );
  const action = createAction();
  const save = (e: SubmitEvent): void => {
    e.preventDefault();
    void action.run(async () => {
      const name = hostname().trim();
      const body = { provider: provider(), ...(name ? { hostname: name } : {}) };
      const done = await api("/api/tunnel/setup", warningSchema, { method: "POST", body });
      props.onSaved(done.warning);
    });
  };
  return (
    <form class="int-stack" onSubmit={save}>
      <fieldset class="int-provider">
        <legend>Provider</legend>
        <For each={PROVIDERS}>
          {(p) => (
            <div class="int-choice">
              <label>
                <input
                  type="radio"
                  name="tunnel-provider"
                  checked={provider() === p.id}
                  onChange={() => setProvider(p.id)}
                />
                {p.label}
              </label>
              <p class="int-hint">
                Command: <code>{props.info.commands[p.id].start}</code>
                <Show when={props.info.commands[p.id].stop}>
                  {(stop) => (
                    <>
                      {" "}
                      Undo: <code>{stop()}</code>
                    </>
                  )}
                </Show>
              </p>
            </div>
          )}
        </For>
      </fieldset>
      <Field label={`Hostname ${provider() === "cloudflare" ? "(optional)" : "(required)"}`}>
        {(control) => (
          <input
            {...control()}
            value={hostname()}
            required={provider() !== "cloudflare"}
            maxLength={253}
            placeholder="machine.tailnet.ts.net"
            onInput={(e) => setHostname(e.currentTarget.value)}
          />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={action.busy()}>
          Save choice
        </Button>
      </div>
      <p class="int-hint">Saving writes the choice only. Nothing is started or exposed.</p>
      <ErrorLine message={action.error()} />
    </form>
  );
}

function Start(props: {
  info: TunnelInfo;
  provider: Provider;
  onChanged: (warning: string) => void;
}): JSX.Element {
  const [ticked, setTicked] = createSignal(false);
  const [asking, setAsking] = createSignal(false);
  const action = createAction();
  const go = (): void => {
    setAsking(false);
    void action.run(async () => {
      const body = startBody(props.provider, ticked());
      props.onChanged(
        (await api("/api/tunnel/start", warningSchema, { method: "POST", body })).warning,
      );
    });
  };
  const stop = (): void => {
    void action.run(async () => {
      await api("/api/tunnel", ignored, { method: "DELETE" });
      props.onChanged("Tunnel stopped.");
    });
  };
  return (
    <div class="int-stack">
      <h3>Start</h3>
      <Show when={isPublicProvider(props.provider)}>
        <label class="int-warn">
          <input
            type="checkbox"
            checked={ticked()}
            onChange={(e) => setTicked(e.currentTarget.checked)}
          />
          This makes the whole instance reachable from the internet. I understand and want that.
        </label>
      </Show>
      <div class="int-row">
        <Button
          tone="primary"
          disabled={action.busy() || !canConfirmStart(props.provider, ticked())}
          onClick={() => setAsking(true)}
        >
          Start tunnel
        </Button>
        <Button disabled={action.busy()} onClick={stop}>
          Stop tunnel
        </Button>
      </div>
      <ErrorLine message={action.error()} />
      <ConfirmDialog
        open={asking()}
        title="Confirm tunnel start"
        message={`This runs ${props.info.commands[props.provider].start} now.`}
        confirm="Yes, start the tunnel"
        onConfirm={go}
        onClose={() => setAsking(false)}
      />
    </div>
  );
}

export function TunnelCard(): JSX.Element {
  const info = createLoad("/api/tunnel", infoSchema);
  const [notice, setNotice] = createSignal<string | null>(null);
  const changed = (text: string): void => {
    setNotice(text);
    void info.reload();
  };
  return (
    <Panel
      title="Remote access (tunnel)"
      actions={
        <Show when={info.data()}>
          {(d) => (
            <StatusBadge
              tone={d().running ? "info" : "neutral"}
              value={d().running ? "running" : "stopped"}
            />
          )}
        </Show>
      }
    >
      <div class="int-stack">
        <p class="int-hint">
          Lets your phone and claude.ai reach this instance. It is never started automatically.
        </p>
        <ErrorLine message={info.error()} />
        <Show when={info.data()}>
          {(d) => (
            <>
              <ul class="int-stack" style={{ margin: 0, padding: 0, "list-style": "none" }}>
                <li>
                  Tailscale:{" "}
                  {d().detected.tailscale.installed
                    ? `found${d().detected.tailscale.dnsName ? `, this machine is ${d().detected.tailscale.dnsName}` : ""}`
                    : "not found"}
                </li>
                <li>cloudflared: {d().detected.cloudflared.installed ? "found" : "not found"}</li>
              </ul>
              <p>
                Saved:{" "}
                {d().config ? `${d().config?.provider} ${d().config?.origin ?? ""}` : "nothing"}.
                Running: {d().running ?? "no"}.
              </p>
              <Choice info={d()} onSaved={changed} />
              <Show when={d().config?.provider} keyed>
                {(provider) => (
                  <>
                    <div class="int-sep" />
                    <Start info={d()} provider={provider} onChanged={changed} />
                  </>
                )}
              </Show>
            </>
          )}
        </Show>
        <p class="int-notice" role="status">
          {notice()}
        </p>
      </div>
    </Panel>
  );
}
