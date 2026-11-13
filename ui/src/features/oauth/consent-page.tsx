import { clientInfoSchema, consentResultSchema } from "@shared/oauth";
import { createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { me } from "../../auth/me";
import { authenticate, requestChallengeSchema } from "../../auth/webauthn";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { Button, Help } from "../../ui/atoms";
import { Field } from "../../ui/molecules";
import { ConsentSummary } from "./consent-summary";
import "./consent.css";
import { ScopeList } from "./scope-list";

const verifiedSchema = z.object({ ok: z.literal(true) });

const SCOPE_LABELS: Record<string, string> = {
  board: "Read and change tasks on the board",
  chat: "Read and post chat messages",
};

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

function askedScopes(params: URLSearchParams): string[] {
  const asked = (params.get("scope") ?? "").split(/\s+/).filter((s) => s in SCOPE_LABELS);
  return asked.length > 0 ? asked : Object.keys(SCOPE_LABELS);
}

function optional(params: URLSearchParams, key: string): Record<string, string> {
  const value = params.get(key);
  return value === null ? {} : { [key]: value };
}

function approveBody(params: URLSearchParams, orgId: string, granted: string[]): object {
  return {
    client_id: params.get("client_id") ?? "",
    redirect_uri: params.get("redirect_uri") ?? "",
    code_challenge: params.get("code_challenge") ?? "",
    code_challenge_method: params.get("code_challenge_method") ?? "",
    resource: params.get("resource") ?? "",
    org_id: orgId,
    granted,
    ...optional(params, "scope"),
    ...optional(params, "state"),
  };
}

function denyBody(params: URLSearchParams): object {
  return {
    client_id: params.get("client_id") ?? "",
    redirect_uri: params.get("redirect_uri") ?? "",
    ...optional(params, "state"),
  };
}

async function approve(body: object): Promise<string> {
  const options = await api("/oauth/consent/options", requestChallengeSchema, {
    method: "POST",
    body,
  });
  const response = await authenticate(options);
  await api("/oauth/consent/verify", verifiedSchema, {
    method: "POST",
    body: { ...body, challengeId: options.challengeId, response },
  });
  return (await api("/oauth/consent", consentResultSchema, { method: "POST", body })).redirect;
}

// The server validates every field again on POST; this page only shows what is being asked.
export function ConsentPage(): JSX.Element {
  // The page is served without frame headers, so it refuses to run inside someone else's page.
  if (window.top !== window.self) return <p class="muted">Open this page in its own tab.</p>;
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const clientId = params.get("client_id") ?? "";
  const requested = askedScopes(params);
  const [orgId, setOrgId] = createSignal(me()?.orgs[0]?.id ?? "");
  const [granted, setGranted] = createSignal<string[]>(requested);
  const action = createAction();
  const client = createLoad(`/api/oauth/clients/${encodeURIComponent(clientId)}`, clientInfoSchema);
  const appName = (): string => client.data()?.name ?? "this app";
  const orgName = (): string =>
    me()?.orgs.find((o) => o.id === orgId())?.name ?? "your organisation";
  const toggle = (scope: string): void => {
    setGranted((now) => (now.includes(scope) ? now.filter((s) => s !== scope) : [...now, scope]));
  };
  const answer = (path: "consent" | "deny"): void => {
    void action.run(async () => {
      const body = path === "consent" ? approveBody(params, orgId(), granted()) : denyBody(params);
      const redirect =
        path === "consent"
          ? await approve(body)
          : (await api("/oauth/deny", consentResultSchema, { method: "POST", body })).redirect;
      location.assign(redirect);
    });
  };
  return (
    <main class="consent-page">
      <Show
        when={!client.error()}
        fallback={
          <p class="error" role="alert">
            This request is not valid. Start again from the app that sent you here.
          </p>
        }
      >
        <section class="consent-card" aria-labelledby="consent-title">
          <p class="consent-brand">Harness</p>
          <h1 id="consent-title">Allow {appName()} to use Harness as you?</h1>
          <ConsentSummary
            app={appName()}
            email={me()?.user.email ?? ""}
            host={hostOf(params.get("redirect_uri") ?? "")}
          />
          <Field label="Organisation it applies to">
            {(control) => (
              <select
                {...control()}
                value={orgId()}
                onChange={(e) => setOrgId(e.currentTarget.value)}
              >
                <For each={me()?.orgs ?? []}>{(o) => <option value={o.id}>{o.name}</option>}</For>
              </select>
            )}
          </Field>
          <ScopeList
            legend={`${appName()} can do only what is ticked, as you, in ${orgName()}`}
            scopes={requested.map((key) => ({ key, label: SCOPE_LABELS[key] ?? key }))}
            granted={granted()}
            onToggle={toggle}
          />
          <Show when={granted().length === 0}>
            <Help small>Pick at least one permission to allow.</Help>
          </Show>
          <ErrorLine message={action.error()} />
          <div class="consent-actions">
            <Button tone="secondary" disabled={action.busy()} onClick={() => answer("deny")}>
              Deny
            </Button>
            <Button
              tone="primary"
              disabled={action.busy() || orgId() === "" || granted().length === 0}
              onClick={() => answer("consent")}
            >
              Allow
            </Button>
          </div>
          <Help small>
            Allow asks for your passkey. Deny returns you to{" "}
            {hostOf(params.get("redirect_uri") ?? "")} without giving access.
          </Help>
          <Help small>You can revoke this later in Account, under Remote MCP.</Help>
        </section>
      </Show>
    </main>
  );
}
