import type { Status } from "@shared/board";
import { createSignal, For, type JSX } from "solid-js";
import { StatusBadge } from "../../ui/atoms";
import { statusLabel } from "./move";
import { type BoardCtx, TASK_MIME, TaskCard } from "./task-card";

export function BoardColumn(props: {
  status: Status;
  ids: string[];
  shown: boolean;
  ctx: BoardCtx;
}): JSX.Element {
  const [over, setOver] = createSignal(false);
  return (
    <section
      class="bd-column"
      data-over={over()}
      data-shown={props.shown}
      aria-label={statusLabel(props.status)}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const dragged = e.dataTransfer?.getData(TASK_MIME);
        if (dragged) void props.ctx.move(dragged, props.status);
      }}
    >
      <h2 class="bd-column-head">
        <StatusBadge kind="task" value={props.status} />
        <span class="bd-mono muted">{props.ids.length}</span>
      </h2>
      <ul class="bd-plain">
        <For each={props.ids}>{(id) => <TaskCard id={id} ctx={props.ctx} />}</For>
      </ul>
    </section>
  );
}
