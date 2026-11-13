import { createSignal, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { RecoveryCodes } from "../../auth/recovery-codes";
import { createAction } from "../../ui/action";
import { Button, Help } from "../../ui/atoms";
import { Notice, Panel } from "../../ui/molecules";
import "./account.css";

const regeneratedSchema: z.ZodType<{ recoveryCodes: string[] }> = z.object({
  recoveryCodes: z.array(z.string()),
});

export function Recovery(): JSX.Element {
  const action = createAction();
  const [codes, setCodes] = createSignal<string[] | null>(null);
  const [saved, setSaved] = createSignal(false);
  const regenerate = (): void => {
    void action.run(async () => {
      const done = await api("/api/auth/recovery/regenerate", regeneratedSchema, {
        method: "POST",
        body: {},
      });
      setSaved(false);
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
            <Help small>
              Ten one-time codes sign you in if you lose every passkey. Harness shows them once, so
              save them. New codes make the old ones stop working.
            </Help>
            <Show when={saved()}>
              <Notice tone="success">
                New recovery codes are saved. The old ones no longer work.
              </Notice>
            </Show>
            <div>
              <Button disabled={action.busy()} onClick={regenerate}>
                Generate new codes
              </Button>
            </div>
          </div>
        }
      >
        {(shown) => (
          <RecoveryCodes
            codes={shown()}
            onDone={() => {
              setCodes(null);
              setSaved(true);
            }}
          />
        )}
      </Show>
    </Panel>
  );
}
