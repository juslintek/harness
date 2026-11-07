import { useState } from "preact/hooks";
import { z } from "zod";
import { api, useLoad } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { ignored } from "../auth/me";
import { useAction } from "../auth/use-action";

interface DesktopInfo {
  configPath: string;
  installed: boolean;
  linked: boolean;
}

const infoSchema: z.ZodType<DesktopInfo> = z.object({
  configPath: z.string(),
  installed: z.boolean(),
  linked: z.boolean(),
});

export function DesktopCard(): preact.JSX.Element {
  const info = useLoad(() => api("/api/integrations/claude-desktop", infoSchema), []);
  const [notice, setNotice] = useState<string | null>(null);
  const action = useAction();
  const change = (method: "POST" | "DELETE", done: string): void => {
    action
      .run(async () => {
        await api("/api/integrations/claude-desktop/link", ignored, { method });
        setNotice(done);
        info.reload();
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <section class="card" aria-labelledby="desktop-h">
      <h3 id="desktop-h">Claude Desktop</h3>
      <p class="muted">
        Linking edits the Claude Desktop config file and keeps a backup of it first. Restart Claude
        Desktop afterwards so it picks up the change.
      </p>
      <ErrorLine message={action.error ?? info.error} />
      {info.data && (
        <>
          <p class="desktop-path">
            Config file: <code>{info.data.configPath}</code>
          </p>
          <p>
            {info.data.installed ? "Claude Desktop found." : "Claude Desktop not found."}{" "}
            {info.data.linked ? "Linked." : "Not linked."}
          </p>
          <div class="row">
            <button
              type="button"
              disabled={action.busy}
              onClick={() => change("POST", "Linked. Restart Claude Desktop.")}
            >
              Link Claude Desktop
            </button>
            <button
              type="button"
              class="danger"
              disabled={action.busy || !info.data.linked}
              onClick={() => change("DELETE", "Unlinked. Restart Claude Desktop.")}
            >
              Unlink
            </button>
          </div>
        </>
      )}
      <p class="muted" role="status">
        {notice}
      </p>
    </section>
  );
}
