import type { OrgLogHit } from "@shared/logs";
import type { JSX } from "solid-js";
import { shortStamp } from "../../format";
import { StatusBadge, statusWord } from "../../ui/atoms";

const when = shortStamp;

export function LogRow(props: { slug: string; hit: OrgLogHit; admin: boolean }): JSX.Element {
  const kind = (): { word: string; tone: "danger" | "neutral" } => ({
    word: statusWord(props.hit.kind).word,
    tone: props.hit.kind === "error" ? "danger" : "neutral",
  });
  return (
    <tr>
      <td class="muted" data-label="Time">
        {when(props.hit.ts)}
      </td>
      <td class="logs-plain" data-label="Member">
        {props.hit.memberHandle}
      </td>
      <td class="logs-plain" data-label="Kind">
        <StatusBadge tone={kind().tone} value={kind().word} />
      </td>
      <td>
        <pre class="logs-snippet">{props.hit.snippet}</pre>
      </td>
      <td class="logs-plain" data-label="Task and run">
        <span class="logs-links">
          {props.hit.projectId && props.hit.taskNumber ? (
            <a href={`#/o/${props.slug}/board/${props.hit.projectId}/${props.hit.taskNumber}`}>
              #{props.hit.taskNumber}
            </a>
          ) : null}
          {/* The run page is for instance admins only. */}
          {props.admin && props.hit.runId ? (
            <a href={`#/runs/${props.hit.runId}`} title={props.hit.runId}>
              {props.hit.runId.slice(0, 8)}
            </a>
          ) : null}
        </span>
      </td>
    </tr>
  );
}
