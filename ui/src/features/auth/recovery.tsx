import { createSignal, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { RecoveryCodes } from "../../auth/recovery-codes";
import { createAction } from "../../ui/action";
import { Button, Panel } from "../../ui/primitives";
import "./account.css";

const regeneratedSchema: z.ZodType<{ recoveryCodes: string[] }> = z.object({
  recoveryCodes: z.array(z.string()),
});

export function Recovery(): JSX.Element {
  const action = createAction();
  const [codes, setCodes] = createSignal<string[] | null>(null);
  const regenerate = (): void => {
    void action.run(async () => {
      const done = await api("/api/auth/recovery/regenerate", regeneratedSchema, {
        method: "POST",
        body: {},
      });
      setCodes(done.recoveryCodes);
    });
  };
  return (
    <Panel title="Recovery codes">
      <ErrorLine message={action.error()} />
      <Show
        when={codes()}
        fallback={
          <div class="acct-stack">
            <p class="acct-meta">Generating new codes makes the old ones stop working.</p>
            <div>
              <Button disabled={action.busy()} onClick={regenerate}>
                Regenerate recovery codes
              </Button>
            </div>
          </div>
        }
      >
        {(shown) => <RecoveryCodes codes={shown()} onDone={() => setCodes(null)} />}
      </Show>
    </Panel>
  );
}
