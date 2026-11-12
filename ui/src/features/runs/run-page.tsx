import { approvalViewSchema, type EventView, type RunView, runDetailSchema } from "@shared/runs";
import { createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { errorText } from "../../format";
import { createLoad } from "../../load";
import { createTopic } from "../../realtime";
import { createAction } from "../../ui/action";
import { CodeBlock } from "../../ui/code-block";
import { Button, Panel, StatusBadge } from "../../ui/primitives";
import { ApprovalCard } from "../approvals/approval-card";
import { fmtDuration, fmtTime, RUN_TONE, VERDICT_TONE } from "./format";
import "./runs.css";

const okSchema = z.object({ ok: z.literal(true) });
const approvalList = z.array(approvalViewSchema);
const LIVE = new Set(["queued", "starting", "running"]);

function EventItem(props: { event: EventView }): JSX.Element {
  const e = props.event;
  return (
    <li class="event" data-kind={e.kind}>
      <div class="event-line">
        <time class="mono">{fmtTime(e.ts)}</time>
        <span class="mono event-kind">{e.kind}</span>
        <Show when={e.toolName}>{(tool) => <code class="mono event-tool">{tool()}</code>}</Show>
        <Show when={e.guardVerdict}>
          {(verdict) => (
            <>
              <Show when={e.guardLayer}>{(layer) => <span class="mono">{layer()}</span>}</Show>
              <StatusBadge tone={VERDICT_TONE[verdict()] ?? "neutral"} value={verdict()} />
            </>
          )}
        </Show>
        <Show when={e.guardRule}>{(rule) => <span class="mono">{rule()}</span>}</Show>
      </div>
      <Show when={e.command}>
        {(command) => <CodeBlock text={command()} label="command" copy={false} />}
      </Show>
      <Show when={e.body}>
        {(body) => (
          <details class="event-body">
            <summary>Body</summary>
            <pre>{body()}</pre>
          </details>
        )}
      </Show>
    </li>
  );
}

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
  return { run, events, error };
}

function Fact(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <>
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </>
  );
}

export function RunPage(props: { id: string }): JSX.Element {
  const { run, events, error } = createRun(props.id);
  const kill = createAction();
  const approvals = createLoad("/api/approvals?status=pending", approvalList, ["approvals"]);
  const mine = () => (approvals.data() ?? []).filter((a) => a.runId === props.id);
  return (
    <div class="page-stack">
      <p>
        <a href="#/runs">Back to runs</a>
      </p>
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
              <div class="run-head">
                <h2 class="run-id">{r().id}</h2>
                <StatusBadge tone={RUN_TONE[r().state]} value={r().state} />
                <Show when={r().reason}>{(reason) => <span class="muted">{reason()}</span>}</Show>
                <span style={{ flex: 1 }} />
                <Show when={LIVE.has(r().state)}>
                  <Button
                    tone="danger"
                    disabled={kill.busy()}
                    onClick={() =>
                      void kill.run(async () => {
                        await api(`/api/runs/${props.id}/kill`, okSchema, {
                          method: "POST",
                          body: {},
                        });
                      })
                    }
                  >
                    Kill run
                  </Button>
                </Show>
              </div>
              <Show when={kill.error()}>
                {(message) => (
                  <p class="error" role="alert">
                    {message()}
                  </p>
                )}
              </Show>
              <p class="run-facts">
                {r().agentId} · {r().model ?? "default model"} · {r().repo}
                {r().branch ? ` · branch ${r().branch}` : ""}
              </p>
              <Show when={mine().length > 0}>
                <section aria-label="Pending approvals" class="run-main">
                  <For each={mine()}>
                    {(approval) => (
                      <ApprovalCard
                        approval={approval}
                        agentId={r().agentId}
                        onDecided={() => void approvals.reload()}
                      />
                    )}
                  </For>
                </section>
              </Show>
              <section>
                <ol class="event-list" aria-label="Run events">
                  <li class="event-list-head">
                    Events <span class="mono muted">{events().length}</span>
                  </li>
                  <For each={events()}>{(event) => <EventItem event={event} />}</For>
                </ol>
              </section>
            </div>
            <div class="run-side">
              <Panel title="Details">
                <dl class="facts">
                  <Fact label="Status">
                    <StatusBadge tone={RUN_TONE[r().state]} value={r().state} />
                  </Fact>
                  <Fact label="Agent">{r().agentId}</Fact>
                  <Fact label="Model">
                    <span class="mono">{r().model ?? "-"}</span>
                  </Fact>
                  <Fact label="Repo">
                    <span class="mono">{r().repo}</span>
                  </Fact>
                  <Fact label="Branch">
                    <span class="mono">{r().branch ?? "-"}</span>
                  </Fact>
                  <Fact label="Started">
                    <span class="mono">{fmtTime(r().startedAt)}</span>
                  </Fact>
                  <Fact label="Duration">
                    <span class="mono">{fmtDuration(r().startedAt, r().endedAt)}</span>
                  </Fact>
                  <Fact label="Prompt">{r().prompt}</Fact>
                </dl>
              </Panel>
              <Panel title="Usage">
                <dl class="facts">
                  <Fact label="Tokens in">
                    <span class="mono">{r().inputTokens}</span>
                  </Fact>
                  <Fact label="Tokens out">
                    <span class="mono">{r().outputTokens}</span>
                  </Fact>
                </dl>
              </Panel>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
