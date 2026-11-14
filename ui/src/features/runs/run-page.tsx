import { approvalViewSchema, type EventView, type RunView, runDetailSchema } from "@shared/runs";
import { createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { errorText } from "../../format";
import { createLoad } from "../../load";
import { createTopic } from "../../realtime";
import { DecidableApprovalCard } from "../../ui/organisms";
import { createRunContext, isLive, whyStarted } from "./data";
import { EventStream } from "./event-stream";
import { FinishedNotice } from "./finished-notice";
import { RunHeader } from "./run-header";
import { DetailsPanel, UsagePanel } from "./run-side";
import "./runs.css";
import { WhyBlock } from "./why-block";

const approvalList = z.array(approvalViewSchema);

// Only events after the last seen row id are fetched; a topic message just asks for the next page.
function createRun(id: string) {
  const [run, setRun] = createSignal<RunView>();
  const [events, setEvents] = createSignal<EventView[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      api(`/api/runs/${id}?after=${last}`, runDetailSchema).then(
        (detail) => {
          setRun(detail.run);
          setError(null);
          if (detail.events.length === 0) return;
          last = detail.events[detail.events.length - 1]?.rowid ?? last;
          setEvents((old) => {
            const seen = new Set(old.map((e) => e.rowid));
            return [...old, ...detail.events.filter((e) => !seen.has(e.rowid))];
          });
        },
        (err: unknown) => setError(errorText(err)),
      );
    }, 100);
  };
  createTopic(`run:${id}`, refresh);
  onCleanup(() => clearTimeout(timer));
  return { run, events, error, refresh };
}

export function RunPage(props: { id: string }): JSX.Element {
  const { run, events, error, refresh } = createRun(props.id);
  const approvals = createLoad("/api/approvals?status=pending", approvalList, ["approvals"]);
  const context = createRunContext();
  const mine = () => (approvals.data() ?? []).filter((a) => a.runId === props.id);
  const wakeup = () => context.wakeupOf(props.id);
  const why = () => whyStarted(wakeup(), true);
  return (
    <div class="page-stack">
      <Show when={error()}>
        {(message) => (
          <p class="error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={run()}>
        {(r) => (
          <div class="run-layout">
            <div class="run-main">
              <RunHeader
                run={r()}
                approval={mine()[0]}
                why={why()}
                taskNumber={wakeup()?.taskNumber}
                onStopped={refresh}
              />
              <FinishedNotice run={r()} events={events()} />
              <Show when={isLive(r().state) && mine().length > 0}>
                <section aria-label="Pending approvals" class="run-main">
                  <For each={mine()}>
                    {(approval) => (
                      <DecidableApprovalCard
                        approval={approval}
                        agentId={r().agentId}
                        onDecided={() => void approvals.reload()}
                      />
                    )}
                  </For>
                </section>
              </Show>
              <EventStream events={events()} live={isLive(r().state)} />
            </div>
            <div class="run-side">
              <WhyBlock why={why()} wakeup={wakeup()} taskNumber={wakeup()?.taskNumber} />
              <UsagePanel run={r()} usage={context.usageOf(props.id)} />
              <DetailsPanel run={r()} />
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
