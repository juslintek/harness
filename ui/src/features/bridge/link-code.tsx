import { linkCodeSchema } from "@shared/bridge";
import { createSignal, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { createAction } from "../../ui/action";
import { CopyButton } from "../../ui/copy-button";
import { Button } from "../../ui/primitives";
import { FormError } from "../orgs/shared";

export function BridgeLinkCode(props: {
  kind: "slack" | "telegram";
  org?: string;
  onLinked?: () => void;
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
            })
          }
        >
          Get a {provider()} link code
        </Button>
      </div>
      <FormError message={action.error()} />
      <Show when={issued()}>
        {(code) => (
          <div class="notice" role="status">
            <span>
              Send this message to the Harness app in a private {provider()} message:{" "}
              <code>/link {code().code}</code>
            </span>
            <div>
              <CopyButton
                text={`/link ${code().code}`}
                label={`Copy the ${provider()} link command`}
              />
            </div>
            <span class="muted">
              The code works once and expires at {new Date(code().expiresAt).toLocaleString()}.
            </span>
            <Show when={props.kind === "telegram"}>
              <span class="muted">Refresh after the bot receives your message.</span>
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
