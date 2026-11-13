import { createSignal, type JSX } from "solid-js";
import { Button } from "./button";
import "./copy-button.css";

// The clipboard API needs a secure context; on plain http the text stays selectable in its field.
export function CopyButton(props: {
  text: string;
  label: string;
  tone?: "secondary" | "ghost";
}): JSX.Element {
  const [state, setState] = createSignal<"idle" | "done" | "failed">("idle");
  const copy = (): void => {
    navigator.clipboard.writeText(props.text).then(
      () => setState("done"),
      () => setState("failed"),
    );
  };
  return (
    <>
      <Button size="sm" tone={props.tone ?? "secondary"} aria-label={props.label} onClick={copy}>
        {props.label}
      </Button>
      <span class="copy-status" role="status">
        {state() === "done" && "Copied"}
        {state() === "failed" && "Copy failed, select the text and copy it by hand"}
      </span>
    </>
  );
}
