import type { LessonView } from "@shared/memory";
import type { OrgDetail } from "@shared/orgs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ignored } from "../../auth/me";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { Button, Field, State, StatusBadge } from "../../ui/primitives";
import { isMemoryMessage, lessonListSchema, memoryBase } from "./memory-data";

function Lesson(props: {
  detail: OrgDetail;
  lesson: LessonView;
  admin: boolean;
  onDone: () => void;
}): JSX.Element {
  const [body, setBody] = createSignal(props.lesson.body);
  const [reason, setReason] = createSignal("");
  const action = createAction();
  const decide = (decision: "accept" | "reject"): void => {
    void action.run(async () => {
      const path = `${memoryBase(props.detail.org.slug)}/lessons/${props.lesson.id}`;
      await api(path, ignored, {
        method: "POST",
        body: { decision, reason: reason(), body: body() },
      });
      props.onDone();
    });
  };
  const author = (): string => props.lesson.authorHandle;
  return (
    <li class="memory-card">
      <p class="memory-meta">
        <StatusBadge tone="warning" value={props.lesson.status} />
        <span>
          {author()}, {new Date(props.lesson.createdAt).toLocaleString()}, proposed as{" "}
          {props.lesson.scope} / {props.lesson.type}
        </span>
        {" · "}
        <Show when={props.lesson.task} fallback="Task no longer exists">
          {(task) => (
            <a href={`#/o/${props.detail.org.slug}/board/${task().projectId}/${task().number}`}>
              Task #{task().number} {task().title}
            </a>
          )}
        </Show>
      </p>
      <Field label={`Lesson text from ${author()}`}>
        {(c) => (
          <textarea
            {...c()}
            rows={5}
            readOnly={!props.admin}
            value={body()}
            onInput={(e) => setBody(e.currentTarget.value)}
          />
        )}
      </Field>
      <Show when={props.admin}>
        <div class="memory-actions">
          <Field label="Reason (optional)">
            {(c) => (
              <input {...c()} value={reason()} onInput={(e) => setReason(e.currentTarget.value)} />
            )}
          </Field>
          <Button tone="primary" disabled={action.busy()} onClick={() => decide("accept")}>
            Accept
          </Button>
          <Button tone="danger" disabled={action.busy()} onClick={() => decide("reject")}>
            Reject
          </Button>
        </div>
      </Show>
      <Show when={action.error()}>
        {(message) => (
          <p class="memory-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
    </li>
  );
}

export function LessonsPanel(props: {
  detail: OrgDetail;
  admin: boolean;
  topic: string;
}): JSX.Element {
  const list = createLoad(
    () => `${memoryBase(props.detail.org.slug)}/lessons?status=pending`,
    lessonListSchema,
    [props.topic],
    isMemoryMessage,
  );
  return (
    <section class="memory-stack" aria-label="Lessons waiting for review">
      <Show when={!props.admin}>
        <p class="memory-meta">Only org admins can accept or reject lessons.</p>
      </Show>
      <Show when={list.error()}>
        {(message) => <State kind="error" message={message()} onRetry={() => void list.reload()} />}
      </Show>
      <Show when={list.data()?.length === 0}>
        <State kind="empty" message="No lessons are waiting." />
      </Show>
      <ul class="memory-plain">
        <For each={list.data()}>
          {(l) => (
            <Lesson
              detail={props.detail}
              lesson={l}
              admin={props.admin}
              onDone={() => void list.reload()}
            />
          )}
        </For>
      </ul>
    </section>
  );
}
