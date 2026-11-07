import { z } from "zod";
import { type GrantView, grantViewSchema } from "../../../shared/oauth";
import { api, useLoad } from "../../api";
import { CopyButton } from "../../copy-button";
import { fmtTime } from "../../format";
import { ErrorLine } from "./error-line";
import { ignored } from "./me";
import { useAction } from "./use-action";

const grantsSchema: z.ZodType<GrantView[]> = z.array(grantViewSchema);

export function McpCard(): preact.JSX.Element {
  const url = `${location.origin}/mcp/remote`;
  const grants = useLoad(() => api("/api/oauth/grants", grantsSchema), []);
  const action = useAction();
  const revoke = (g: GrantView): void => {
    action
      .run(async () => {
        await api(`/api/oauth/grants/${encodeURIComponent(g.id)}`, ignored, { method: "DELETE" });
        grants.reload();
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <section class="card" aria-labelledby="mcp-h">
      <h3 id="mcp-h">Remote MCP (claude.ai, ChatGPT)</h3>
      <p class="muted">
        Add this URL as a custom connector. The client then asks you to approve access with your
        passkey. It only works where this address is reachable from the client.
      </p>
      <div class="row">
        <label>
          Connector URL
          <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        </label>
        <CopyButton text={url} label="Copy the remote MCP URL" />
      </div>
      <h4>Active grants</h4>
      <ErrorLine message={action.error ?? grants.error} />
      {grants.data?.length === 0 && <p class="muted">No client has access.</p>}
      <ul class="plain">
        {grants.data?.map((g) => (
          <li key={g.id} class="row target-row">
            <span class="target-label">
              <strong>{g.clientName}</strong> in {g.orgName}, {g.scopes.join(", ") || "no scopes"}
              <span class="muted"> since {fmtTime(g.createdAt)}</span>
            </span>
            <button
              type="button"
              class="danger"
              disabled={action.busy}
              aria-label={`Revoke access of ${g.clientName} to ${g.orgName}`}
              onClick={() => revoke(g)}
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
