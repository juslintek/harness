import { type GrantView, grantViewSchema } from "@shared/oauth";
import { For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { ignored } from "../../auth/me";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { CopyButton } from "../../ui/copy-button";
import { Button, Field, Panel } from "../../ui/primitives";
import "./account.css";
import { fmtTime } from "./time";

export function McpCard(): JSX.Element {
  const url = `${location.origin}/mcp/remote`;
  const grants = createLoad("/api/oauth/grants", z.array(grantViewSchema));
  const action = createAction();
  const revoke = (g: GrantView): void => {
    void action.run(async () => {
      await api(`/api/oauth/grants/${encodeURIComponent(g.id)}`, ignored, { method: "DELETE" });
      await grants.reload();
    });
  };
  return (
    <Panel title="Remote MCP (claude.ai, ChatGPT)">
      <div class="acct-stack">
        <p class="acct-meta">
          Add this URL as a custom connector. The client then asks you to approve access with your
          passkey. It only works where this address is reachable from the client.
        </p>
        <div class="acct-add">
          <Field label="Connector URL">
            {(control) => (
              <input
                {...control()}
                class="mono"
                readOnly
                value={url}
                onFocus={(e) => e.currentTarget.select()}
              />
            )}
          </Field>
          <CopyButton text={url} label="Copy the remote MCP URL" />
        </div>
        <h3 class="acct-sub">Active grants</h3>
        <ErrorLine message={action.error() ?? grants.error()} />
        <Show when={grants.data()?.length === 0}>
          <p class="acct-meta">No client has access.</p>
        </Show>
        <ul class="acct-list">
          <For each={grants.data()}>
            {(g) => (
              <li class="acct-item">
                <span class="acct-text">
                  <span>
                    <strong>{g.clientName}</strong> in {g.orgName},{" "}
                    {g.scopes.join(", ") || "no scopes"}
                  </span>
                  <span class="acct-meta">since {fmtTime(g.createdAt)}</span>
                </span>
                <Button
                  size="sm"
                  tone="danger"
                  disabled={action.busy()}
                  aria-label={`Revoke access of ${g.clientName} to ${g.orgName}`}
                  onClick={() => revoke(g)}
                >
                  Revoke
                </Button>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Panel>
  );
}
