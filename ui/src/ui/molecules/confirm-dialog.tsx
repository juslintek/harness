import type { JSX } from "solid-js";
import { Button } from "../atoms";
import { Dialog } from "./dialog";

// Name the object and the consequence in `message`. The confirming button is filled danger only
// when the action destroys something; the caller closes it from onConfirm once the request is sent.
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  message: string;
  confirm: string;
  destructive?: boolean;
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
          <Button
            tone={props.destructive === false ? "primary" : "danger"}
            onClick={props.onConfirm}
          >
            {props.confirm}
          </Button>
        </>
      }
    >
      <p>{props.message}</p>
    </Dialog>
  );
}
