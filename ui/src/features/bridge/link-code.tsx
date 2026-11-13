import { linkCodeSchema } from "@shared/bridge";
import { createSignal, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { createAction } from "../../ui/action";
import { Button, CopyButton, Help } from "../../ui/atoms";
import { FormError } from "../orgs/shared";
import "./bridge.css";

export function BridgeLinkCode(props: {
  kind: "slack" | "telegram";
  org?: string;
  onLinked?: () => void;
  onIssued?: () => void;
}): JSX.Element {
  const [issued, setIssued] = createSignal<{ code: string; expiresAt: number } | null>(null);
  const action = createAction();
  const provider = (): string => (props.kind === "slack" ? "Slack" : "Telegram");
  return (
    <div class="stack">
      <div>
        <Button
          disabled={action.busy()}
          onClick={() =>
            void action.run(async () => {
              const query = props.org ? `?org=${encodeURIComponent(props.org)}` : "";
              setIssued(
                await api(`/api/bridge/${props.kind}/link-code${query}`, linkCodeSchema, {
                  method: "POST",
                }),
              );
              props.onIssued?.();
            })
          }
        >
          Get a {provider()} link code
        </Button>
      </div>
      <FormError message={action.error()} />
      <Show when={issued()}>
        {(code) => (
          <div class="link-code">
            <p>Send this message to the Harness app in a private {provider()} message:</p>
            <div class="link-code-row">
              <code>/link {code().code}</code>
              <CopyButton text={`/link ${code().code}`} label="Copy command" />
            </div>
            <Help small>
              The code works once and expires at{" "}
              {new Date(code().expiresAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}{" "}
              (10 minutes).
            </Help>
            <Show when={props.kind === "telegram"}>
              <Help small>Refresh after the bot receives your message.</Help>
            </Show>
            <Show when={props.onLinked}>
              {(linked) => (
                <div>
                  <Button onClick={() => linked()()}>Refresh the list</Button>
                </div>
              )}
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
