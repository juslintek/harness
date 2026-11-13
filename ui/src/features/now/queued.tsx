import { For, type JSX } from "solid-js";
import { Help, StatusBadge } from "../../ui/atoms";
import { TableBox } from "../../ui/molecules";
import { wakeReason } from "../../wakeups";
import type { NowData } from "./now-data";
import { NowSection } from "./now-section";
import { hhmm } from "./time";

export function Queued(props: { data: NowData }): JSX.Element {
  const d = (): NowData => props.data;
  return (
    <NowSection title="Queued" count={d().queued().length}>
      {d().halted() ? <Help>These wait. They start after agents are resumed.</Help> : null}
      <TableBox stack label="Queued">
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col">Agent</th>
            <th scope="col">Why it will start</th>
            <th scope="col">Task</th>
            <th scope="col">Queued at</th>
          </tr>
        </thead>
        <tbody>
          <For each={d().queued()}>
            {(w) => (
              <tr>
                <td data-label="Status">
                  <StatusBadge tone="neutral" value="queued" />
                </td>
                <td data-label="Agent">@{d().handleOf(w.memberId) ?? "agent"}</td>
                <td data-label="Why it will start">{wakeReason(w, undefined)}</td>
                <td data-label="Task" class="mono">
                  {w.taskNumber === null ? "no task" : `#${w.taskNumber}`}
                </td>
                <td data-label="Queued at" class="mono">
                  {hhmm(w.createdAt)}
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </TableBox>
    </NowSection>
  );
}
