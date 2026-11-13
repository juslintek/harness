import { createSignal, type JSX } from "solid-js";
import { Button } from "../atoms";
import { ConfirmDialog } from "./confirm-dialog";

// A button that asks first. Quiet danger by default; for an action that destroys nothing pass
// another tone, and the confirming button stops being red.
export function ConfirmButton(props: {
  text: string;
  title: string;
  message: string;
  confirm: string;
  onConfirm: () => void;
  label?: string;
  tone?: "primary" | "secondary" | "danger-quiet";
  size?: "sm" | "md";
  destructive?: boolean;
  disabled?: boolean;
}): JSX.Element {
  const [asking, setAsking] = createSignal(false);
  return (
    <>
      <Button
        size={props.size ?? "md"}
        tone={props.tone ?? "danger-quiet"}
        disabled={props.disabled ?? false}
        aria-label={props.label}
        onClick={() => setAsking(true)}
      >
        {props.text}
      </Button>
      <ConfirmDialog
        open={asking()}
        title={props.title}
        message={props.message}
        confirm={props.confirm}
        destructive={props.destructive ?? (props.tone ?? "danger-quiet") === "danger-quiet"}
        onClose={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          props.onConfirm();
        }}
      />
    </>
  );
}
