import { type GrantView, grantViewSchema } from "@shared/oauth";
import { createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { ignored, me } from "../../auth/me";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { ButtonLink, CopyButton, Help, StatusBadge } from "../../ui/atoms";
import { ConfirmButton, Field, Notice, Panel } from "../../ui/molecules";
import { AcctItem } from "./acct-item";
import "./account.css";
import { fmtTime } from "./time";

export function McpCard(): JSX.Element {
  const url = `${location.origin}/mcp/remote`;
  const grants = createLoad("/api/oauth/grants", z.array(grantViewSchema));
  const action = createAction();
  const [done, setDone] = createSignal<string | null>(null);
  const revoke = (g: GrantView): void => {
    setDone(null);
    void action.run(async () => {
      await api(`/api/oauth/grants/${encodeURIComponent(g.id)}`, ignored, { method: "DELETE" });
      await grants.reload();
      setDone(`Revoked access of ${g.clientName} to ${g.orgName}.`);
    });
  };
  return (
    <Panel title="Remote MCP (claude.ai, ChatGPT)">
      <div class="acct-stack">
        <Help small>
          Lets claude.ai or ChatGPT read and change your board and chat as you. Add this URL as a
          custom connector in the client. It then asks you to approve access with your passkey.
        </Help>
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
          <CopyButton text={url} label="Copy URL" />
        </div>
        <Notice
          tone="info"
          title="The client must be able to reach this address"
          actions={
            <Show when={me()?.user.instanceAdmin}>
              <ButtonLink href="#/integrations">Open Integrations</ButtonLink>
            </Show>
          }
        >
          On a private network it will not connect. Start a tunnel under Integrations first.
        </Notice>
        <h3 class="acct-sub">Active grants</h3>
        <ErrorLine message={action.error() ?? grants.error()} />
        <Show when={done()}>{(text) => <Notice tone="success">{text()}</Notice>}</Show>
        <Show when={grants.data()?.length === 0}>
          <Help small>
            A client appears here once you approve it. Revoke cuts its access at once.
          </Help>
        </Show>
        <ul class="acct-list">
          <For each={grants.data()}>
            {(g) => (
              <AcctItem
                title={
                  <span>
                    <strong>{g.clientName}</strong> in {g.orgName}{" "}
                    <StatusBadge tone="success" value="connected" />
                  </span>
                }
                meta={`Can use: ${g.scopes.join(", ") || "no scopes"} · connected ${fmtTime(g.createdAt)}`}
                action={
                  <ConfirmButton
                    size="sm"
                    text="Revoke"
                    confirm="Revoke"
                    label={`Revoke access of ${g.clientName} to ${g.orgName}`}
                    title={`Revoke access of ${g.clientName}?`}
                    message={`${g.clientName} can no longer read or change anything in ${g.orgName}. It has to ask again to get back in.`}
                    disabled={action.busy()}
                    onConfirm={() => revoke(g)}
                  />
                }
              />
            )}
          </For>
        </ul>
      </div>
    </Panel>
  );
}
