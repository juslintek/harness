import type { JSX } from "solid-js";
import { Button, Dialog } from "../ui/primitives";
import { answerStepUp, pendingAction } from "./step-up-prompt";

export function StepUpDialog(): JSX.Element {
  return (
    <Dialog
      open={pendingAction() !== null}
      onClose={() => answerStepUp(false)}
      title="Confirm it's you"
      footer={
        <>
          <Button onClick={() => answerStepUp(false)}>Cancel</Button>
          <Button tone="primary" onClick={() => answerStepUp(true)}>
            Use passkey
          </Button>
        </>
      }
    >
      <p>
        This needs a fresh passkey check. Your browser will ask for your passkey. The check stays
        valid for 5 minutes.
      </p>
      <code class="dialog-action">{pendingAction()}</code>
    </Dialog>
  );
}
