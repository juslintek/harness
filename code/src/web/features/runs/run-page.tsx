import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { z } from "zod";
import { type EventView, type RunView, runDetailSchema } from "../../../shared/runs";
import { api, useTopic } from "../../api";
import { errorText, fmtDuration, fmtTime } from "../../format";
import { PendingApprovals } from "../approvals/approvals";

const okSchema = z.object({ ok: z.literal(true) });
const LIVE = new Set(["queued", "starting", "running"]);

function EventItem({ event }: { event: EventView }): preact.JSX.Element {
  return (
    <li class="event">
      <div class="event-head">
        <span class="kind">{event.kind}</span>
        <time class="muted">{fmtTime(event.ts)}</time>
        {event.toolName && <code>{event.toolName}</code>}
        {event.guardVerdict && (
          <span class="badge" data-verdict={event.guardVerdict}>
            {event.guardLayer ? `${event.guardLayer} ` : ""}
            {event.guardVerdict}
          </span>
        )}
      </div>
      {event.command && <pre class="command">{event.command}</pre>}
      {event.body && (
        <details>
          <summary>Body</summary>
          <pre class="body">{event.body}</pre>
        </details>
      )}
    </li>
  );
}

function useRun(id: string): { run: RunView | null; events: EventView[]; error: string | null } {
  const [run, setRun] = useState<RunView | null>(null);
  const [events, setEvents] = useState<EventView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refresh = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api(`/api/runs/${id}?after=${last.current}`, runDetailSchema).then(
        (d) => {
          setRun(d.run);
          setError(null);
          if (d.events.length === 0) return;
          last.current = d.events[d.events.length - 1]?.rowid ?? last.current;
          setEvents((old) => {
            const seen = new Set(old.map((e) => e.rowid));
            return [...old, ...d.events.filter((e) => !seen.has(e.rowid))];
          });
        },
        (err: unknown) => setError(errorText(err)),
      );
    }, 100);
  }, [id]);
  useEffect(() => {
    last.current = 0;
    setEvents([]);
    refresh();
    return () => clearTimeout(timer.current);
  }, [refresh]);
  useTopic(`run:${id}`, refresh);
  return { run, events, error };
}

function KillButton({ id }: { id: string }): preact.JSX.Element {
  const [message, setMessage] = useState<string | null>(null);
  const kill = async (): Promise<void> => {
    try {
      await api(`/api/runs/${id}/kill`, okSchema, { method: "POST", body: {} });
    } catch (err) {
      setMessage(errorText(err));
    }
  };
  return (
    <>
      <button type="button" class="danger" onClick={kill}>
        Kill run
      </button>
      {message && (
        <span class="error" role="alert">
          {message}
        </span>
      )}
    </>
  );
}

function Summary({ run }: { run: RunView }): preact.JSX.Element {
  return (
    <dl class="summary">
      <dt>State</dt>
      <dd>
        <span class="badge" data-state={run.state}>
          {run.state}
        </span>
        {run.reason && <span class="muted"> {run.reason}</span>}
      </dd>
      <dt>Agent</dt>
      <dd>
        {run.agentId} {run.model ?? ""}
      </dd>
      <dt>Repo</dt>
      <dd>
        {run.repo} {run.branch ? `(${run.branch})` : ""}
      </dd>
      <dt>Tokens in / out</dt>
      <dd>
        {run.inputTokens} / {run.outputTokens}
      </dd>
      <dt>Duration</dt>
      <dd>{fmtDuration(run.startedAt, run.endedAt)}</dd>
      <dt>Prompt</dt>
      <dd class="prompt">{run.prompt}</dd>
    </dl>
  );
}

export function RunPage({ id }: { id: string }): preact.JSX.Element {
  const { run, events, error } = useRun(id);
  return (
    <>
      <p>
        <a href="#/runs">Back to runs</a>
      </p>
      <h2>Run</h2>
      {error && <p class="error">{error}</p>}
      {run && (
        <>
          <Summary run={run} />
          {LIVE.has(run.state) && <KillButton id={id} />}
          <PendingApprovals runId={id} />
          <h3>Events</h3>
          <ol class="plain" aria-label="Run events">
            {events.map((e) => (
              <EventItem key={e.rowid} event={e} />
            ))}
          </ol>
        </>
      )}
    </>
  );
}
