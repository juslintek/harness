import { haltBody } from "@shared/runs";
import { createSignal, type JSX, Show } from "solid-js";
import { api } from "../api";
import { errorText } from "../format";
import { createLoad } from "../load";
import { Button, Dialog, Switch } from "../ui/primitives";

// Instance admins only. The switch shows what the server says; a click asks first, then POSTs
// (which may need a passkey), then reads the state again, so a refused change snaps back.
export function HaltSwitch(): JSX.Element {
  const state = createLoad("/api/halt", haltBody);
  const [asking, setAsking] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);
  const halted = (): boolean => state.data()?.halted === true;
  const confirm = async (): Promise<void> => {
    setAsking(false);
    try {
      await api("/api/halt", haltBody, { method: "POST", body: { halted: !halted() } });
      setFailure(null);
    } catch (err) {
      setFailure(errorText(err));
    }
    await state.reload();
  };
  return (
    <Show when={state.data()}>
      <div class="halt-area">
        <Show when={failure()}>
          {(message) => (
            <span class="halt-error" role="alert">
              {message()}
            </span>
          )}
        </Show>
        <fieldset class="halt" data-halted={halted()}>
          <legend class="sr-only">Halt all agent runs</legend>
          <span class="halt-label">
            <span class="halt-long">{halted() ? "Halted" : "Agents running"}</span>
            <span class="halt-short">{halted() ? "Halted" : "Running"}</span>
          </span>
          <Switch
            checked={halted()}
            onChange={() => setAsking(true)}
            ariaLabel="Halt all agent runs"
            tone="danger"
          />
        </fieldset>
      </div>
      <Dialog
        open={asking()}
        onClose={() => setAsking(false)}
        title={halted() ? "Resume all runs?" : "Halt all runs?"}
        footer={
          <>
            <Button onClick={() => setAsking(false)}>Cancel</Button>
            <Button tone={halted() ? "primary" : "danger"} onClick={confirm}>
              {halted() ? "Resume" : "Halt"}
            </Button>
          </>
        }
      >
        <p>
          {halted()
            ? "Resume the harness and allow new runs?"
            : "Halt the harness? Every live run is killed and new runs are refused."}
        </p>
      </Dialog>
    </Show>
  );
}
