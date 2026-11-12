import { createSignal, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { ignored } from "../../auth/me";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { Button, Panel, StatusBadge } from "../../ui/primitives";

const infoSchema = z.object({
  configPath: z.string(),
  installed: z.boolean(),
  linked: z.boolean(),
});

export function DesktopCard(): JSX.Element {
  const info = createLoad("/api/integrations/claude-desktop", infoSchema);
  const [notice, setNotice] = createSignal<string | null>(null);
  const action = createAction();
  const change = (method: "POST" | "DELETE", done: string): void => {
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
                value={d().installed ? "found" : "not found"}
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
        <p class="int-hint">
          Linking edits the Claude Desktop config file and keeps a backup of it first. Restart
          Claude Desktop afterwards so it picks up the change.
        </p>
        <ErrorLine message={action.error() ?? info.error()} />
        <Show when={info.data()}>
          {(d) => (
            <>
              <p>
                Config file: <code>{d().configPath}</code>
              </p>
              <div class="int-row">
                <Button
                  tone="primary"
                  disabled={action.busy()}
                  onClick={() => change("POST", "Linked. Restart Claude Desktop.")}
                >
                  Link Claude Desktop
                </Button>
                <Button
                  tone="danger"
                  disabled={action.busy() || !d().linked}
                  onClick={() => change("DELETE", "Unlinked. Restart Claude Desktop.")}
                >
                  Unlink
                </Button>
              </div>
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
