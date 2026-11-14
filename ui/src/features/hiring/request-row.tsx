import type { HireView } from "@shared/hiring";
import type { JSX } from "solid-js";
import { filedStamp } from "../../format";
import { ButtonLink, StatusBadge, statusWord } from "../../ui/atoms";
import { whereIs } from "./hire-phase";

export function RequestRow(props: {
  hire: HireView;
  slug: string;
  team: string;
  // Only an admin can decide, so only an admin is offered the Decide button.
  canDecide: boolean;
}): JSX.Element {
  const href = (): string => `#/o/${props.slug}/hiring/${props.hire.id}`;
  const status = (): ReturnType<typeof statusWord> => statusWord(props.hire.status, "hire");
  return (
    <tr class="request-row" data-needs={props.hire.status === "deciding" ? "" : undefined}>
      <td>
        <a class="hire-link" href={href()}>
          {props.hire.spec.title}
        </a>
      </td>
      <td data-label="Team">{props.team}</td>
      <td data-label="Specialty" class="mono">
        {props.hire.spec.specialty}
      </td>
      <td data-label="Filed">{filedStamp(props.hire.createdAt)}</td>
      <td data-label="Where it is">{whereIs(props.hire.status)}</td>
      <td data-label="Status">
        <StatusBadge tone={status().tone} value={status().word} />
      </td>
      <td class="request-action">
        {props.hire.status === "deciding" && props.canDecide ? (
          <ButtonLink tone="primary" href={href()}>
            Decide
          </ButtonLink>
        ) : (
          <span class="sr-only">No action</span>
        )}
      </td>
    </tr>
  );
}
