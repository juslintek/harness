import type { JSX } from "solid-js";
import { ConfirmButton } from "../../ui/molecules";
import { KIND_LABELS, type Link } from "./bridge-data";

export function BridgeRow(props: {
  link: Link;
  channel: string;
  busy: boolean;
  onRemove: () => void;
}): JSX.Element {
  const service = (): string => KIND_LABELS[props.link.kind];
  return (
    <tr>
      <th scope="row">#{props.channel}</th>
      <td data-label="Service">{service()}</td>
      <td data-label="External id" class="settings-id">
        {props.link.externalId}
      </td>
      <td class="actions-cell">
        <ConfirmButton
          size="sm"
          text="Remove"
          disabled={props.busy}
          label={`Remove the ${service()} bridge of #${props.channel}`}
          title={`Remove the ${service()} bridge of #${props.channel}?`}
          message={`Messages in #${props.channel} stop mirroring to ${service()}. The channel and its messages stay in Harness.`}
          confirm="Remove bridge"
          onConfirm={props.onRemove}
        />
      </td>
    </tr>
  );
}
