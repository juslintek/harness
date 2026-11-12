import { linkCodeSchema } from "@shared/bridge";
import { createSignal, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { createAction } from "../../ui/action";
import { CopyButton } from "../../ui/copy-button";
import { Button } from "../../ui/primitives";
import { fmtTime } from "../auth/time";

// The telegram target is created by the bot when it receives this code, so the list is refreshed by hand.
export function TelegramLinkCode(props: { org: string; onLinked: () => void }): JSX.Element {
  const [issued, setIssued] = createSignal<{ code: string; expiresAt: number } | null>(null);
  const action = createAction();
  const request = (): void => {
    void action.run(async () => {
      setIssued(
        await api(
          `/api/bridge/telegram/link-code?org=${encodeURIComponent(props.org)}`,
          linkCodeSchema,
          { method: "POST" },
        ),
      );
    });
  };
  return (
    <div class="nf-stack">
      <div>
        <Button disabled={action.busy()} onClick={request}>
          Get a Telegram link code
        </Button>
      </div>
      <ErrorLine message={action.error()} />
      <Show when={issued()}>
        {(code) => (
          <div class="nf-once" role="status">
            <p>
              Send this message to the Harness app in a private Telegram message:{" "}
              <code>/link {code().code}</code>
            </p>
            <div class="nf-row">
              <CopyButton text={`/link ${code().code}`} label="Copy the Telegram link command" />
              <Button onClick={props.onLinked}>Refresh the list</Button>
            </div>
            <p class="nf-hint">
              The code works once and expires at {fmtTime(code().expiresAt)}. Refresh after the bot
              receives your message.
            </p>
          </div>
        )}
      </Show>
    </div>
  );
}
