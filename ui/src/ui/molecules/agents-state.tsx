import { type JSX, Show } from "solid-js";
import { Button, Dot } from "../atoms";
import "./agents-state.css";

// Admins get the stop or resume button next to the words. On a phone the words shrink to "Running"
// or "Stopped" and the button is left to the drawer footer (AgentsToggle).
export function AgentsState(props: {
  halted: boolean;
  admin: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <div class="agents-state">
      <Dot tone={props.halted ? "warning" : "success"} />
      <span class="agents-state-text">
        <span class="agents-state-long">{props.halted ? "Agents stopped" : "Agents running"}</span>
        <span class="agents-state-short">{props.halted ? "Stopped" : "Running"}</span>
      </span>
      <Show when={props.admin}>
        <span class="agents-state-button">
          <AgentsToggle halted={props.halted} onToggle={props.onToggle} />
        </span>
      </Show>
    </div>
  );
}

export function AgentsToggle(props: { halted: boolean; onToggle: () => void }): JSX.Element {
  return (
    <Button
      size="sm"
      tone={props.halted ? "primary" : "danger-quiet"}
      onClick={() => props.onToggle()}
    >
      {props.halted ? "Resume agents" : "Stop all agents"}
    </Button>
  );
}
