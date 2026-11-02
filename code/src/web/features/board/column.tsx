import { useState } from "preact/hooks";
import type { Status, TaskView } from "../../../shared/board";
import { STATUS_LABEL } from "./moves-client";
import { type BoardCtx, TaskCard } from "./task-card";

export function Column({
  status,
  tasks,
  ctx,
}: {
  status: Status;
  tasks: TaskView[];
  ctx: BoardCtx;
}): preact.JSX.Element {
  const [over, setOver] = useState(false);
  return (
    <section
      class="column"
      data-over={over}
      aria-label={STATUS_LABEL[status]}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const dragged = e.dataTransfer?.getData("text/plain");
        if (dragged) ctx.move(dragged, status);
      }}
    >
      <h3>
        {STATUS_LABEL[status]} <span class="muted">{tasks.length}</span>
      </h3>
      <ul class="plain">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} ctx={ctx} />
        ))}
      </ul>
    </section>
  );
}
