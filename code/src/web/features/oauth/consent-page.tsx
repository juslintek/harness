import { useState } from "preact/hooks";
import { clientInfoSchema, consentResultSchema } from "../../../shared/oauth";
import { api, useLoad } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { me } from "../auth/me";
import { useAction } from "../auth/use-action";

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

function Choices(props: {
  requested: string[];
  orgId: string;
  granted: string[];
  onOrg: (id: string) => void;
  onToggle: (scope: string) => void;
}): preact.JSX.Element {
  return (
    <>
      <fieldset>
        <legend>Organisation</legend>
        <select
          aria-label="Organisation"
          value={props.orgId}
          onChange={(e) => props.onOrg(e.currentTarget.value)}
        >
          {(me.value?.orgs ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </fieldset>
      <fieldset>
        <legend>Permissions</legend>
        {props.requested.map((scope) => (
          <label key={scope} class="consent-scope">
            <input
              type="checkbox"
              checked={props.granted.includes(scope)}
              onChange={() => props.onToggle(scope)}
            />
            {SCOPE_LABELS[scope]}
          </label>
        ))}
      </fieldset>
    </>
  );
}

// The server validates every field again on POST; this page only shows what is being asked.
export function ConsentPage(): preact.JSX.Element {
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const clientId = params.get("client_id") ?? "";
  const requested = askedScopes(params);
  const [orgId, setOrgId] = useState(me.value?.orgs[0]?.id ?? "");
  const [granted, setGranted] = useState<string[]>(requested);
  const action = useAction();
  const client = useLoad(
    () => api(`/api/oauth/clients/${encodeURIComponent(clientId)}`, clientInfoSchema),
    [clientId],
  );
  const toggle = (scope: string): void =>
    setGranted((now) => (now.includes(scope) ? now.filter((s) => s !== scope) : [...now, scope]));
  const answer = (path: "consent" | "deny"): Promise<void> =>
    action.run(async () => {
      const body = path === "consent" ? approveBody(params, orgId, granted) : denyBody(params);
      const result = await api(`/oauth/${path}`, consentResultSchema, { method: "POST", body });
      location.assign(result.redirect);
    });
  if (client.error) {
    return (
      <p class="error" role="alert">
        This request is not valid. Start again from the app that sent you here.
      </p>
    );
  }
  return (
    <section class="consent" aria-labelledby="consent-title">
      <h3 id="consent-title">Allow access to Harness?</h3>
      <p>
        <strong>{client.data?.name ?? "…"}</strong> wants to act as you. It will return you to{" "}
        <code>{hostOf(params.get("redirect_uri") ?? "")}</code>.
      </p>
      <Choices
        requested={requested}
        orgId={orgId}
        granted={granted}
        onOrg={setOrgId}
        onToggle={toggle}
      />
      <ErrorLine message={action.error} />
      <div class="row">
        <button
          type="button"
          disabled={action.busy || orgId === "" || granted.length === 0}
          onClick={() => answer("consent")}
        >
          Approve
        </button>
        <button type="button" class="danger" disabled={action.busy} onClick={() => answer("deny")}>
          Deny
        </button>
      </div>
      <p class="muted">Approving asks for your passkey.</p>
    </section>
  );
}
