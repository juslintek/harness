import { createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { ignored } from "../../auth/me";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { CopyButton, Help, StatusBadge } from "../../ui/atoms";
import { ConfirmButton, Field, Notice, Panel } from "../../ui/molecules";
import { ProviderOption } from "./provider-option";
import {
  canConfirmStart,
  isPublicProvider,
  PROVIDERS,
  type Provider,
  startBody,
} from "./tunnel-logic";
import { TunnelSteps } from "./tunnel-steps";

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

const setupSchema = z.object({ warning: z.string() });
const startSchema = z.object({ warning: z.string(), origin: z.string().nullable() });

function Tunnel(props: { info: TunnelInfo; onChanged: () => Promise<void> }): JSX.Element {
  const running = (): Provider | null => props.info.running;
  const [provider, setProvider] = createSignal<Provider>(
    running() ?? props.info.config?.provider ?? "tailscale-serve",
  );
  const [hostname, setHostname] = createSignal(
    props.info.config?.origin?.replace("https://", "") ??
      props.info.detected.tailscale.dnsName ??
      "",
  );
  const [ticked, setTicked] = createSignal(false);
  // A Cloudflare address exists only in the start answer; Tailscale's comes from the saved config.
  const [started, setStarted] = createSignal<{ origin: string | null; warning: string } | null>(
    null,
  );
  const action = createAction();
  const current = (): (typeof PROVIDERS)[number] =>
    PROVIDERS.find((p) => p.id === provider()) ?? (PROVIDERS[0] as (typeof PROVIDERS)[number]);
  const address = (): string | null => props.info.config?.origin ?? started()?.origin ?? null;
  const start = (): void => {
    void action.run(async () => {
      setStarted(null);
      const name = hostname().trim();
      const saved = await api("/api/tunnel/setup", setupSchema, {
        method: "POST",
        body: { provider: provider(), ...(name ? { hostname: name } : {}) },
      });
      await props.onChanged();
      const done = await api("/api/tunnel/start", startSchema, {
        method: "POST",
        body: startBody(provider(), ticked()),
      });
      setStarted({ origin: done.origin, warning: done.warning || saved.warning });
      await props.onChanged();
    });
  };
  const stop = (): void => {
    void action.run(async () => {
      await api("/api/tunnel", ignored, { method: "DELETE" });
      setStarted(null);
      await props.onChanged();
    });
  };
  return (
    <div class="int-stack">
      <TunnelSteps running={running() !== null} />
      <ul class="int-plain int-detect">
        <li>
          Tailscale:{" "}
          {props.info.detected.tailscale.installed ? (
            <>
              found
              <Show when={props.info.detected.tailscale.dnsName}>
                {(name) => (
                  <>
                    , this machine is <code>{name()}</code>
                  </>
                )}
              </Show>
            </>
          ) : (
            "not found"
          )}
        </li>
        <li>cloudflared: {props.info.detected.cloudflared.installed ? "found" : "not found"}</li>
      </ul>
      <Show
        when={running()}
        fallback={
          <Notice tone="info" title="Stopped" standing>
            {props.info.config
              ? `Saved choice: ${PROVIDERS.find((p) => p.id === props.info.config?.provider)?.name ?? ""}${props.info.config.origin ? ` at ${props.info.config.origin}` : ""}.`
              : "Nothing saved yet."}
          </Notice>
        }
      >
        {(live) => (
          <Notice
            tone="success"
            title={`Tunnel is running with ${PROVIDERS.find((p) => p.id === live())?.name ?? ""}`}
          >
            Passkeys are tied to the address. A passkey made on localhost does not work on the
            tunnel address: sign in there with a recovery code or an email code, then add a passkey.
            Localhost still works to manage or stop the tunnel.
            <Show when={started()?.warning}>{(text) => <p>{text()}</p>}</Show>
          </Notice>
        )}
      </Show>
      <Show when={running() !== null && address()}>
        {(url) => (
          <div class="int-stack">
            <div class="int-address">
              <h3>Address</h3>
              <div class="int-address-row">
                <code>{url()}</code>
                <CopyButton text={url()} label="Copy URL" />
              </div>
            </div>
            <div class="int-row">
              <a
                class="btn"
                data-tone="secondary"
                data-size="md"
                href={url()}
                target="_blank"
                rel="noreferrer"
              >
                Open the address
              </a>
            </div>
            <Help small>
              Use this address in <a href="#/account">Account › Remote MCP</a> (connector URL{" "}
              <code>{url()}/mcp/remote</code>) and on your phone.
            </Help>
            <Show when={running() === "tailscale-serve"}>
              <Help small>
                Only people on your tailnet can reach this address. To change the provider or
                hostname, stop the tunnel first.
              </Help>
            </Show>
            <div class="int-sep" />
          </div>
        )}
      </Show>
      <Show when={running() === null}>
        <fieldset class="int-provider">
          <legend>Provider</legend>
          <For each={PROVIDERS}>
            {(p) => (
              <ProviderOption
                id={p.id}
                label={p.label}
                start={props.info.commands[p.id].start}
                stop={props.info.commands[p.id].stop}
                checked={provider() === p.id}
                disabled={running() !== null}
                onSelect={() => {
                  setProvider(p.id);
                  setTicked(false);
                }}
              >
                <Show when={provider() === p.id && isPublicProvider(p.id) && running() === null}>
                  <label class="int-check">
                    <input
                      type="checkbox"
                      checked={ticked()}
                      onChange={(e) => setTicked(e.currentTarget.checked)}
                    />
                    I understand the instance will be reachable from the internet
                  </label>
                </Show>
              </ProviderOption>
            )}
          </For>
        </fieldset>
        <Field
          label={`Hostname ${provider() === "cloudflare" ? "(optional)" : "(required for Tailscale)"}`}
        >
          {(control) => (
            <input
              {...control()}
              value={hostname()}
              disabled={running() !== null}
              maxLength={253}
              placeholder="machine.tailnet.ts.net"
              onInput={(e) => setHostname(e.currentTarget.value)}
            />
          )}
        </Field>
      </Show>
      <div class="int-stack int-tight">
        <div class="int-row">
          <ConfirmButton
            tone="primary"
            text={`Start with ${current().name}`}
            disabled={
              action.busy() ||
              running() !== null ||
              !canConfirmStart(provider(), ticked()) ||
              (provider() !== "cloudflare" && hostname().trim() === "")
            }
            title="Confirm tunnel start"
            message={`This runs ${props.info.commands[provider()].start} now and saves your choice.`}
            confirm="Yes, start the tunnel"
            onConfirm={start}
          />
          <ConfirmButton
            text="Stop tunnel"
            disabled={action.busy() || running() === null}
            title="Stop remote access?"
            message="Phones and claude.ai lose the connection to this instance. Localhost keeps working."
            confirm="Stop tunnel"
            onConfirm={stop}
          />
        </div>
        <Show when={running() === null}>
          <Help small>
            Start saves your choice and starts the tunnel. Both ask for your passkey. Stop is
            available once it runs.
          </Help>
        </Show>
      </div>
      <ErrorLine message={action.error()} />
    </div>
  );
}

export function TunnelCard(): JSX.Element {
  const info = createLoad("/api/tunnel", infoSchema);
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
        <Help small>
          A tunnel lets your phone and claude.ai reach this instance from outside your network. It
          never starts by itself.
        </Help>
        <ErrorLine message={info.error()} />
        <Show when={info.data()}>
          {(d) => <Tunnel info={d()} onChanged={() => info.reload()} />}
        </Show>
      </div>
    </Panel>
  );
}
