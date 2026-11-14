import { createSignal, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { errorText } from "../../format";
import { Button } from "../../ui/atoms";
import { Notice } from "../../ui/molecules";
import { postTask } from "./move";
import type { WithTask } from "./panel-types";

const fmtClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// Take task and Let go are the old checkout and release; Run now only exists for an agent assignee.
export function PanelActions(props: WithTask & { onAsked: () => void }): JSX.Element {
  const [error, setError] = createSignal<string | null>(null);
  const [asked, setAsked] = createSignal<string | null>(null);
  const act = async (verb: "checkout" | "release"): Promise<void> => {
    try {
      const r = await postTask(`/api/tasks/${props.id}/${verb}`, {}, props.handleOf);
      setError(r.ok ? null : r.message);
      if (r.ok) await props.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const wake = async (): Promise<void> => {
    try {
      await api(`/api/members/${props.task().assigneeId}/wake`, z.unknown(), {
        method: "POST",
        body: { taskId: props.id },
      });
      setError(null);
      setAsked(props.task().assignee?.handle ?? null);
      props.onAsked();
    } catch (err) {
      setAsked(null);
      setError(errorText(err));
    }
  };
  return (
    <div class="bd-panel-block">
      <div class="bd-panel-buttons">
        <Button onClick={() => void act("checkout")}>Take task</Button>
        <Button onClick={() => void act("release")}>Let go</Button>
        <Show when={props.task().assignee?.kind === "agent"}>
          <Button onClick={() => void wake()}>Run now</Button>
        </Show>
      </div>
      <Show when={props.task().holder}>
        {(holder) => (
          <p class="muted bd-small">
            @{holder().handle} is working on it
            <Show when={props.task().checkedOutAt}>
              {(at) => (
                <>
                  {" "}
                  since <span class="bd-mono">{fmtClock(at())}</span>
                </>
              )}
            </Show>
          </p>
        )}
      </Show>
      <Show when={asked()}>
        {(handle) => (
          <Notice
            tone="success"
            actions={
              <Button
                onClick={() => {
                  location.hash = "#/now";
                }}
              >
                Open Now
              </Button>
            }
          >
            Asked @{handle()} to run. It starts as soon as a slot is free. Watch it under Now.
          </Notice>
        )}
      </Show>
      <Show when={error()}>
        {(text) => (
          <p class="bd-small" role="alert">
            {text()}
          </p>
        )}
      </Show>
    </div>
  );
}
