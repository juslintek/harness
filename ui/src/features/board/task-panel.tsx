import { type TaskView, taskDetailSchema } from "@shared/board";
import { createEffect, type JSX, onMount, Show } from "solid-js";
import { ErrorLine } from "../../auth/error-line";
import { createLoad } from "../../load";
import { ButtonLink } from "../../ui/atoms";
import { Notice } from "../../ui/molecules";
import type { Wakeup } from "../../wakeups";
import { PanelActions } from "./panel-actions";
import { BlockedBy } from "./panel-blocked";
import { Comments } from "./panel-comments";
import { PanelEdit } from "./panel-edit";
import { PanelRuns } from "./panel-runs";
import { Subtasks } from "./panel-subtasks";
import type { PanelProps } from "./panel-types";

export function TaskPanel(
  props: PanelProps & { wakeups: () => Wakeup[]; reloadWakeups: () => Promise<void> },
): JSX.Element {
  const task = (): TaskView => props.tasks().find((t) => t.id === props.id) as TaskView;
  const loaded = createLoad(() => `/api/tasks/${props.id}`, taskDetailSchema);
  // The board refetch says something changed; the detail has subtasks, deps and comments of its own.
  let first = true;
  createEffect(() => {
    props.version();
    if (!first) void loaded.reload();
    first = false;
  });
  let panel!: HTMLElement;
  onMount(() => panel.focus());
  const closeHref = `#/o/${props.detail.org.slug}/board/${task().projectId}`;
  return (
    <aside class="bd-task-panel" aria-label={`Task #${task().number}`} tabindex="-1" ref={panel}>
      <header class="bd-task-panel-head">
        <span class="bd-mono">#{task().number}</span>
        <ButtonLink tone="ghost" size="sm" href={closeHref}>
          <span class="bd-when-wide">Close</span>
          <span class="bd-when-narrow">Back</span>
        </ButtonLink>
      </header>
      <div class="bd-task-panel-body">
        <PanelEdit
          {...props}
          task={task}
          waiting={
            <Show when={props.work(props.id)}>
              {(work) => (
                <Show when={work().waiting}>
                  <Notice
                    tone="warning"
                    title={`Run ${work().runId} is waiting for you`}
                    actions={
                      <>
                        <ButtonLink tone="primary" size="sm" href="#/approvals">
                          Review approval
                        </ButtonLink>
                        <ButtonLink size="sm" href={`#/runs/${work().runId}`}>
                          Open run
                        </ButtonLink>
                      </>
                    }
                  >
                    @{task().holder?.handle ?? task().assignee?.handle ?? "An agent"} asked to run{" "}
                    {work().command}.
                  </Notice>
                </Show>
              )}
            </Show>
          }
        >
          <PanelActions {...props} task={task} onAsked={() => void props.reloadWakeups()} />
          <PanelRuns wakeups={props.wakeups} />
          <Show when={loaded.data()}>{(info) => <BlockedBy {...props} info={info} />}</Show>
        </PanelEdit>
        <ErrorLine message={loaded.error()} />
        <Show when={loaded.data()}>
          {(info) => (
            <>
              <Subtasks {...props} info={info} />
              <Comments {...props} comments={() => info().comments} />
            </>
          )}
        </Show>
      </div>
    </aside>
  );
}
