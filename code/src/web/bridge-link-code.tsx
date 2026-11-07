import { useState } from "preact/hooks";
import { linkCodeSchema } from "../shared/bridge";
import { api } from "./api";
import { CopyButton } from "./copy-button";
import { ErrorLine } from "./features/auth/error-line";
import { useAction } from "./features/auth/use-action";
import { fmtTime } from "./format";

export function BridgeLinkCode({
  kind,
  org,
  onLinked,
}: {
  kind: "slack" | "telegram";
  org?: string;
  onLinked?: () => void;
}): preact.JSX.Element {
  const [issued, setIssued] = useState<{ code: string; expiresAt: number } | null>(null);
  const action = useAction();
  const request = (): void => {
    action
      .run(async () => {
        const query = org ? `?org=${encodeURIComponent(org)}` : "";
        setIssued(
          await api(`/api/bridge/${kind}/link-code${query}`, linkCodeSchema, { method: "POST" }),
        );
      })
      .catch((err: unknown) => console.error(err));
  };
  const provider = kind === "slack" ? "Slack" : "Telegram";
  return (
    <div>
      <button type="button" disabled={action.busy} onClick={request}>
        Get a {provider} link code
      </button>
      <ErrorLine message={action.error} />
      {issued && (
        <div class="card" role="status">
          <p>
            Send this message to the Harness app in a private {provider} message:{" "}
            <code>/link {issued.code}</code>
          </p>
          <CopyButton text={`/link ${issued.code}`} label={`Copy the ${provider} link command`} />
          <p class="muted">The code works once and expires at {fmtTime(issued.expiresAt)}.</p>
          {kind === "telegram" && <p class="muted">Refresh after the bot receives your message.</p>}
          {onLinked && (
            <button type="button" onClick={onLinked}>
              Refresh the list
            </button>
          )}
        </div>
      )}
    </div>
  );
}
