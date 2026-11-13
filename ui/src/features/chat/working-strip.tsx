import type { ChatMember } from "@shared/chat";
import { For, type JSX } from "solid-js";
import { me } from "../../auth/me";
import { createLoad } from "../../load";
import { useNow } from "../../ui/organisms";
import { wakeupList } from "../../wakeups";

// Which agents are running because of this channel. Wakeups are not pushed, so the list is read
// again whenever the chat topic says something happened.
export function WorkingStrip(props: {
  slug: string;
  channelId: string;
  members: Map<string, ChatMember>;
  bump: () => unknown;
}): JSX.Element {
  // `seen` only changes the path, which is what makes the load fetch again.
  const wakeups = createLoad(
    () => `/api/orgs/${props.slug}/wakeups?limit=200&seen=${props.bump() ?? 0}`,
    wakeupList,
  );
  const now = useNow();
  const handleOf = (memberId: string): string =>
    [...props.members.values()].find((m) => m.id === memberId)?.handle ?? "An agent";
  const active = () =>
    (wakeups.data() ?? []).filter((w) => w.channelId === props.channelId && w.status === "started");
  return (
    <For each={active()}>
      {(w) => (
        <p class="working-strip">
          <span aria-hidden="true">●</span>
          <span>
            {handleOf(w.memberId)} is working
            {w.taskNumber === null ? "" : ` on #${w.taskNumber}`}
          </span>
          {w.runId && me()?.user.instanceAdmin ? (
            <span>
              run <a href={`#/runs/${w.runId}`}>{w.runId}</a>
            </span>
          ) : null}
          {w.startedAt === null ? null : (
            <span>{Math.max(1, Math.floor((now() - w.startedAt) / 60_000))} min</span>
          )}
        </p>
      )}
    </For>
  );
}
