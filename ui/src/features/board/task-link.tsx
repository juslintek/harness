import type { TaskView } from "@shared/board";
import type { JSX } from "solid-js";

export function TaskLink(props: { slug: string; task: TaskView }): JSX.Element {
  return (
    <a href={`#/o/${props.slug}/board/${props.task.projectId}/${props.task.number}`}>
      <span class="bd-mono muted">#{props.task.number}</span> {props.task.title}
    </a>
  );
}
