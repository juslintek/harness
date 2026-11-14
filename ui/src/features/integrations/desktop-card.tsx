import { createSignal, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { ignored } from "../../auth/me";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { Button, Help, StatusBadge } from "../../ui/atoms";
import { ConfirmButton, Notice, Panel, Steps } from "../../ui/molecules";

const infoSchema = z.object({
  configPath: z.string(),
  installed: z.boolean(),
  linked: z.boolean(),
});

export function DesktopCard(): JSX.Element {
  const info = createLoad("/api/integrations/claude-desktop", infoSchema);
  const [notice, setNotice] = createSignal<{ title: string; body: string } | null>(null);
  const action = createAction();
  const change = (method: "POST" | "DELETE", done: { title: string; body: string }): void => {
    void action.run(async () => {
      await api("/api/integrations/claude-desktop/link", ignored, { method });
      setNotice(done);
      await info.reload();
    });
  };
  return (
    <Panel
      title="Claude Desktop"
      actions={
        <Show when={info.data()}>
          {(d) => (
            <>
              <StatusBadge
                tone={d().installed ? "success" : "neutral"}
                value={d().installed ? "installed" : "not installed"}
              />
              <StatusBadge
                tone={d().linked ? "success" : "neutral"}
                value={d().linked ? "linked" : "not linked"}
              />
            </>
          )}
        </Show>
      }
    >
      <div class="int-stack">
        <Help small>
          Lets Claude Desktop read and change your board and chat as you. Linking edits the Claude
          Desktop config file and keeps a backup of it first. Asks for your passkey.
        </Help>
        <ErrorLine message={action.error() ?? info.error()} />
        <Show when={info.data()}>
          {(d) => (
            <>
              <Steps
                label="Claude Desktop steps"
                items={[
                  { label: "Link", state: d().linked ? "done" : "current" },
                  { label: "Restart Claude Desktop", state: d().linked ? "current" : "todo" },
                  { label: "Check it works", state: "todo" },
                ]}
              />
              <p>
                Config file: <code>{d().configPath}</code>
              </p>
              <Show when={notice()}>
                {(text) => (
                  <Notice tone="success" title={text().title}>
                    {text().body}
                  </Notice>
                )}
              </Show>
              <Show
                when={d().linked}
                fallback={
                  <div class="int-row">
                    <Button
                      tone="primary"
                      disabled={action.busy()}
                      onClick={() =>
                        change("POST", {
                          title: "Linked",
                          body: 'Restart Claude Desktop, then ask it "list my Harness tasks" to check.',
                        })
                      }
                    >
                      Link Claude Desktop
                    </Button>
                  </div>
                }
              >
                <div class="int-stack int-tight">
                  <div class="int-row">
                    <ConfirmButton
                      tone="secondary"
                      text="Unlink Claude Desktop"
                      disabled={action.busy()}
                      title="Unlink Claude Desktop?"
                      message="Harness is taken out of the Claude Desktop config file. A backup is kept. Restart Claude Desktop afterwards."
                      confirm="Unlink"
                      onConfirm={() =>
                        change("DELETE", { title: "Unlinked", body: "Restart Claude Desktop." })
                      }
                    />
                  </div>
                  <Help small>
                    Unlinking removes the entry from the config file and revokes its link token.
                  </Help>
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>
    </Panel>
  );
}
