import { linkCodeSchema } from "@shared/bridge";
import { createSignal, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { createAction } from "../../ui/action";
import { Button, CopyButton, Help } from "../../ui/atoms";
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
      <Help small>
        Get a code, then send /link CODE to the Harness bot in a private chat. The code works once
        and expires after 10 minutes.
      </Help>
      <ErrorLine message={action.error()} />
      <Show when={issued()}>
        {(code) => (
          <div class="nf-once" role="status">
            <p>
              Send this message to the Harness app in a private Telegram message:{" "}
              <code>/link {code().code}</code>
            </p>
            <div class="nf-row">
              <CopyButton text={`/link ${code().code}`} label="Copy command" />
              <Button onClick={props.onLinked}>Refresh the list</Button>
            </div>
            <Help small>
              The code works once and expires at {fmtTime(code().expiresAt)}. Refresh after the bot
              receives your message.
            </Help>
          </div>
        )}
      </Show>
    </div>
  );
}
