import type { ApprovalView } from "@shared/runs";
import { For, type JSX } from "solid-js";
import { Help } from "../../ui/atoms";
import { DecidableApprovalCard } from "../../ui/organisms";
import { NeedsRow } from "./needs-row";
import type { NowData } from "./now-data";
import { NowSection } from "./now-section";

export function NeedsYou(props: { data: NowData }): JSX.Element {
  const d = (): NowData => props.data;
  const agentOf = (runId: string): string | undefined => {
    const w = d()
      .wakeups.data()
      ?.find((x) => x.runId === runId);
    return w ? d().handleOf(w.memberId) : undefined;
  };
  return (
    <NowSection title="Needs you" count={d().needsCount()} tone="warning">
      <Help>
        Each of these waits for a person.
        {d().approvalRows().length > 0 && " Deciding on an approval asks for your passkey."}
      </Help>
      <ul class="now-list" aria-label="Needs you">
        <For
          each={d()
            .approvalRows()
            .map((a) => a.id)}
        >
          {(id) => {
            const approval = (): ApprovalView =>
              d()
                .approvalRows()
                .find((a) => a.id === id) as ApprovalView;
            return (
              <li>
                <DecidableApprovalCard
                  approval={approval()}
                  agentId={agentOf(approval().runId)}
                  runButton
                  onDecided={(updated) => {
                    if (updated) d().keep(updated);
                    void d().reload();
                  }}
                />
              </li>
            );
          }}
        </For>
        <For each={d().needRows()}>{(row) => <NeedsRow row={row} />}</For>
      </ul>
    </NowSection>
  );
}
