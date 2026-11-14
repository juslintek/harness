import type { LessonView } from "@shared/memory";
import type { OrgDetail } from "@shared/orgs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ignored } from "../../auth/me";
import { minuteStamp } from "../../format";
import type { Load } from "../../load";
import { createAction } from "../../ui/action";
import { Button, StatusBadge } from "../../ui/atoms";
import { Field, Panel, State } from "../../ui/molecules";
import { kindWord, memoryBase, scopeWord } from "./memory-data";
import { MemoryError } from "./memory-error";

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
    <li>
      <Panel title={`Lesson from ${author()}`}>
        <div class="memory-stack">
          <p class="memory-meta">
            <StatusBadge tone="warning" value="waiting for you" />
            <span>
              proposed by {author()} · {minuteStamp(props.lesson.createdAt)}
            </span>
            <span>
              will be saved as a <b>{kindWord(props.lesson.type)}</b> for the{" "}
              <b>{scopeWord(props.lesson.scope)}</b>
            </span>
            <Show when={props.lesson.task} fallback={<span>Task no longer exists</span>}>
              {(task) => (
                <a href={`#/o/${props.detail.org.slug}/board/${task().projectId}/${task().number}`}>
                  Task #{task().number} {task().title}
                </a>
              )}
            </Show>
          </p>
          <Field
            label={
              props.admin
                ? "Lesson text. You can edit it before you accept."
                : `Lesson text from ${author()}`
            }
          >
            {(c) => (
              <textarea
                {...c()}
                rows={3}
                readOnly={!props.admin}
                value={body()}
                onInput={(e) => setBody(e.currentTarget.value)}
              />
            )}
          </Field>
          <Show when={props.admin}>
            <Field label="Reason (optional)">
              {(c) => (
                <input
                  {...c()}
                  value={reason()}
                  onInput={(e) => setReason(e.currentTarget.value)}
                />
              )}
            </Field>
            <div class="memory-actions">
              <Button tone="primary" disabled={action.busy()} onClick={() => decide("accept")}>
                Accept lesson
              </Button>
              <Button disabled={action.busy()} onClick={() => decide("reject")}>
                Reject lesson
              </Button>
            </div>
          </Show>
          <MemoryError message={action.error()} />
        </div>
      </Panel>
    </li>
  );
}

export function LessonsPanel(props: {
  detail: OrgDetail;
  admin: boolean;
  list: Load<LessonView[]>;
}): JSX.Element {
  const list = props.list;
  return (
    <section class="memory-stack" aria-label="Lessons waiting for review">
      <Show when={!props.admin}>
        <p class="memory-meta">Only org admins can accept or reject lessons.</p>
      </Show>
      <Show when={list.error()}>
        {(message) => <State kind="error" message={message()} onRetry={() => void list.reload()} />}
      </Show>
      <Show when={list.data()?.length === 0}>
        <State
          kind="empty"
          message="No lessons are waiting. When an agent finishes a task it can propose short lessons here."
        />
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
