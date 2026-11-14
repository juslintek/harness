import type { JSX } from "solid-js";
import { ButtonLink, StatusBadge } from "../../ui/atoms";
import type { NeedRow } from "./now-data";

export function NeedsRow(props: { row: NeedRow }): JSX.Element {
  return (
    <li class="now-need">
      <div class="now-need-main">
        <p class="now-need-head">
          <span class="now-need-category">{props.row.category}</span>
          <StatusBadge tone={props.row.badge.tone} value={props.row.badge.word} />
          <strong>{props.row.title}</strong>
        </p>
        <p class="now-need-line">{props.row.line}</p>
      </div>
      <ButtonLink href={props.row.action.href}>{props.row.action.label}</ButtonLink>
    </li>
  );
}
