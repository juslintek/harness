import type { JSX } from "solid-js";
import { Button, Dialog } from "./primitives";

// Destructive actions ask first. The caller closes it from onConfirm once the request is sent.
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  message: string;
  confirm: string;
  onConfirm: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button tone="danger" onClick={props.onConfirm}>
            {props.confirm}
          </Button>
        </>
      }
    >
      <p>{props.message}</p>
    </Dialog>
  );
}
