import type { JSX } from "solid-js";
import { Steps } from "../../ui/molecules";

export function TunnelSteps(props: { running: boolean }): JSX.Element {
  return (
    <Steps
      label="Remote access steps"
      items={[
        { label: "Choose a provider", state: props.running ? "done" : "current" },
        { label: "Start the tunnel", state: props.running ? "done" : "todo" },
        { label: "Use the address", state: props.running ? "current" : "todo" },
      ]}
    />
  );
}
