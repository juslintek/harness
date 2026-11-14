import { For, type JSX, Show } from "solid-js";
import { ButtonLink, StatusBadge } from "../../ui/atoms";
import { TableBox } from "../../ui/molecules";
import { useNow } from "../../ui/organisms";
import { wakeReason } from "../../wakeups";
import type { NowData } from "./now-data";
import { NowSection } from "./now-section";
import { hhmm } from "./time";

export function WorkingNow(props: { data: NowData }): JSX.Element {
  const d = (): NowData => props.data;
  const now = useNow();
  const admin = d().instanceAdmin;
  const personOf = (causedBy: string | null): string | undefined => {
    const userId = causedBy?.startsWith("user:") ? causedBy.slice(5) : undefined;
    return d()
      .detail.data()
      ?.members.find((m) => m.userId === userId)?.handle;
  };
  const waiting = (runId: string | null): boolean =>
    runId !== null &&
    d()
      .approvalRows()
      .some((a) => a.runId === runId && a.status === "pending");
  return (
    <NowSection title="Working now" count={d().working().length}>
      <TableBox stack label="Working now">
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col">Agent and task</th>
            <Show when={admin}>
              <th scope="col">Run</th>
            </Show>
            <th scope="col">Why it started</th>
            <th scope="col">Started</th>
            <Show when={admin}>
              <th scope="col">
                <span class="sr-only">Actions</span>
              </th>
            </Show>
          </tr>
        </thead>
        <tbody>
          <For each={d().working()}>
            {(w) => (
              <tr>
                <td data-label="Status">
                  {waiting(w.runId) ? (
                    <StatusBadge tone="warning" value="waiting for you" />
                  ) : (
                    <StatusBadge tone="info" value="running" />
                  )}
                </td>
                <td data-label="Agent and task">
                  @{d().agentOf(w)}
                  <Show when={w.taskNumber !== null}>
                    {" "}
                    <span class="mono">#{w.taskNumber}</span>
                  </Show>
                </td>
                <Show when={admin}>
                  <td data-label="Run" class="mono">
                    <Show when={w.runId}>{(id) => <a href={`#/runs/${id()}`}>{id()}</a>}</Show>
                  </td>
                </Show>
                <td data-label="Why it started">{wakeReason(w, personOf(w.causedBy))}</td>
                <td data-label="Started" class="mono">
                  <Show when={w.startedAt}>
                    {(at) => (
                      <>
                        {hhmm(at())} ({Math.max(1, Math.floor((now() - at()) / 60_000))} min)
                      </>
                    )}
                  </Show>
                </td>
                <Show when={admin}>
                  <td class="now-actions">
                    <Show when={w.runId}>
                      {(id) => (
                        <>
                          <ButtonLink href={`#/runs/${id()}`}>Open run</ButtonLink>
                          <ButtonLink href={`#/runs/${id()}`}>Follow live</ButtonLink>
                        </>
                      )}
                    </Show>
                  </td>
                </Show>
              </tr>
            )}
          </For>
        </tbody>
      </TableBox>
    </NowSection>
  );
}
