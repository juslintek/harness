import { useState } from "preact/hooks";
import { z } from "zod";
import { api, useLoad } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { ignored } from "../auth/me";
import { useAction } from "../auth/use-action";
import {
  canConfirmStart,
  isPublicProvider,
  PROVIDERS,
  type Provider,
  startBody,
} from "./tunnel-logic";

const providerSchema: z.ZodType<Provider> = z.enum([
  "tailscale-serve",
  "tailscale-funnel",
  "cloudflare",
]);

interface TunnelInfo {
  detected: {
    tailscale: { installed: boolean; dnsName: string | null };
    cloudflared: { installed: boolean };
  };
  config: { provider: Provider; origin?: string | undefined } | null;
  running: Provider | null;
  commands: Record<Provider, { start: string; stop: string | null }>;
}

const command = z.object({ start: z.string(), stop: z.string().nullable() });
const infoSchema: z.ZodType<TunnelInfo> = z.object({
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

const warningSchema: z.ZodType<{ warning: string }> = z.object({ warning: z.string() });

function Detected({ info }: { info: TunnelInfo }): preact.JSX.Element {
  const { tailscale, cloudflared } = info.detected;
  return (
    <ul class="plain muted">
      <li>
        Tailscale:{" "}
        {tailscale.installed
          ? `found${tailscale.dnsName ? `, this machine is ${tailscale.dnsName}` : ""}`
          : "not found"}
      </li>
      <li>cloudflared: {cloudflared.installed ? "found" : "not found"}</li>
    </ul>
  );
}

function Choice({
  info,
  onSaved,
}: {
  info: TunnelInfo;
  onSaved: (warning: string) => void;
}): preact.JSX.Element {
  const [provider, setProvider] = useState<Provider>(info.config?.provider ?? "tailscale-serve");
  const [hostname, setHostname] = useState(
    info.config?.origin?.replace("https://", "") ?? info.detected.tailscale.dnsName ?? "",
  );
  const action = useAction();
  const save = (e: Event): void => {
    e.preventDefault();
    action
      .run(async () => {
        const body = { provider, ...(hostname.trim() ? { hostname: hostname.trim() } : {}) };
        const done = await api("/api/tunnel/setup", warningSchema, { method: "POST", body });
        onSaved(done.warning);
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <form onSubmit={save}>
      <fieldset>
        <legend>Provider</legend>
        {PROVIDERS.map((p) => (
          <div key={p.id}>
            <label class="inline">
              <input
                type="radio"
                name="tunnel-provider"
                checked={provider === p.id}
                onChange={() => setProvider(p.id)}
              />
              {p.label}
            </label>
            <p class="muted hint">
              Command: <code>{info.commands[p.id].start}</code>
              {info.commands[p.id].stop && (
                <>
                  {" "}
                  Undo: <code>{info.commands[p.id].stop}</code>
                </>
              )}
            </p>
          </div>
        ))}
      </fieldset>
      <label>
        Hostname {provider === "cloudflare" ? "(optional)" : "(required)"}
        <input
          value={hostname}
          required={provider !== "cloudflare"}
          maxLength={253}
          placeholder="machine.tailnet.ts.net"
          onInput={(e) => setHostname(e.currentTarget.value)}
        />
      </label>
      <button type="submit" disabled={action.busy}>
        Save choice
      </button>
      <p class="muted hint">Saving writes the choice only. Nothing is started or exposed.</p>
      <ErrorLine message={action.error} />
    </form>
  );
}

function Start({
  info,
  provider,
  onChanged,
}: {
  info: TunnelInfo;
  provider: Provider;
  onChanged: (warning: string) => void;
}): preact.JSX.Element {
  const [ticked, setTicked] = useState(false);
  const [asking, setAsking] = useState(false);
  const action = useAction();
  const go = (): void => {
    action
      .run(async () => {
        const body = startBody(provider, ticked);
        onChanged(
          (await api("/api/tunnel/start", warningSchema, { method: "POST", body })).warning,
        );
        setAsking(false);
      })
      .catch((err: unknown) => console.error(err));
  };
  const stop = (): void => {
    action
      .run(async () => {
        await api("/api/tunnel", ignored, { method: "DELETE" });
        onChanged("Tunnel stopped.");
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <div class="tunnel-start">
      <h4>Start</h4>
      {isPublicProvider(provider) && (
        <label class="inline warn-box">
          <input
            type="checkbox"
            checked={ticked}
            onChange={(e) => setTicked(e.currentTarget.checked)}
          />
          This makes the whole instance reachable from the internet. I understand and want that.
        </label>
      )}
      {!asking ? (
        <button
          type="button"
          disabled={action.busy || !canConfirmStart(provider, ticked)}
          onClick={() => setAsking(true)}
        >
          Start tunnel
        </button>
      ) : (
        <div class="card" role="alertdialog" aria-label="Confirm tunnel start">
          <p>
            This runs <code>{info.commands[provider].start}</code> now.
          </p>
          <div class="row">
            <button type="button" class="danger" disabled={action.busy} onClick={go}>
              Yes, start the tunnel
            </button>
            <button type="button" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <button type="button" disabled={action.busy} onClick={stop}>
        Stop tunnel
      </button>
      <ErrorLine message={action.error} />
    </div>
  );
}

export function TunnelCard(): preact.JSX.Element {
  const info = useLoad(() => api("/api/tunnel", infoSchema), []);
  const [notice, setNotice] = useState<string | null>(null);
  const changed = (text: string): void => {
    setNotice(text);
    info.reload();
  };
  return (
    <section class="card" aria-labelledby="tunnel-h">
      <h3 id="tunnel-h">Remote access (tunnel)</h3>
      <p class="muted">
        Lets your phone and claude.ai reach this instance. It is never started automatically.
      </p>
      <ErrorLine message={info.error} />
      {info.data && (
        <>
          <Detected info={info.data} />
          <p>
            Saved:{" "}
            {info.data.config
              ? `${info.data.config.provider} ${info.data.config.origin ?? ""}`
              : "nothing"}
            . Running: {info.data.running ?? "no"}.
          </p>
          <Choice info={info.data} onSaved={changed} key={info.data.config?.provider ?? "none"} />
          {info.data.config && (
            <Start info={info.data} provider={info.data.config.provider} onChanged={changed} />
          )}
        </>
      )}
      <p class="muted" role="status">
        {notice}
      </p>
    </section>
  );
}
