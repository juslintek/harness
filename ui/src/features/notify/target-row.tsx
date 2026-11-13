import type { TargetView } from "@shared/notify";
import type { JSX } from "solid-js";
import { ConfirmButton } from "../../ui/molecules";

export function TargetRow(props: {
  target: TargetView;
  channel: string;
  busy: boolean;
  onRemove: (t: TargetView) => void;
}): JSX.Element {
  return (
    <li class="nf-item">
      <span class="nf-item-label">{props.target.label}</span>
      <ConfirmButton
        size="sm"
        text="Remove"
        disabled={props.busy}
        label={`Remove ${props.channel} target ${props.target.label}`}
        title={`Remove ${props.target.label}?`}
        message={`Notifications stop going to this ${props.channel} target. Your other targets are not changed.`}
        confirm="Remove target"
        onConfirm={() => props.onRemove(props.target)}
      />
    </li>
  );
}
