import { useState } from "preact/hooks";
import type { LessonView } from "../../../shared/memory";
import type { OrgDetail } from "../../../shared/orgs";
import { api, useLoad } from "../../api";
import { fmtTime } from "../../format";
import { ErrorLine } from "../auth/error-line";
import { ignored } from "../auth/me";
import { useAction } from "../auth/use-action";
import { handleOf } from "../policies/policies-data";
import { lessonListSchema, memoryBase } from "./memory-data";

function Lesson({
  detail,
  lesson,
  admin,
  onDone,
}: {
  detail: OrgDetail;
  lesson: LessonView;
  admin: boolean;
  onDone: () => void;
}): preact.JSX.Element {
  const [body, setBody] = useState(lesson.body);
  const [reason, setReason] = useState("");
  const action = useAction();
  const decide = (decision: "accept" | "reject"): void => {
    action
      .run(async () => {
        const path = `${memoryBase(detail.org.slug)}/lessons/${lesson.id}`;
        await api(path, ignored, { method: "POST", body: { decision, reason, body } });
        onDone();
      })
      .catch((err: unknown) => console.error(err));
  };
  const author = handleOf(lesson.authorId, detail.members);
  return (
    <li class="card">
      <p class="muted">
        {author}, {fmtTime(lesson.createdAt)}, proposed as {lesson.scope} / {lesson.type}
        {" · "}
        {lesson.task ? (
          <a href={`#/o/${detail.org.slug}/board/${lesson.task.projectId}/${lesson.task.number}`}>
            Task #{lesson.task.number} {lesson.task.title}
          </a>
        ) : (
          "Task no longer exists"
        )}
      </p>
      <label>
        Lesson text from {author}
        <textarea
          rows={5}
          readOnly={!admin}
          value={body}
          onInput={(e) => setBody(e.currentTarget.value)}
        />
      </label>
      {admin && (
        <div class="row">
          <label>
            Reason (optional)
            <input value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
          </label>
          <button type="button" disabled={action.busy} onClick={() => decide("accept")}>
            Accept
          </button>
          <button
            type="button"
            class="danger"
            disabled={action.busy}
            onClick={() => decide("reject")}
          >
            Reject
          </button>
        </div>
      )}
      <ErrorLine message={action.error} />
    </li>
  );
}

export function LessonsPanel({
  detail,
  admin,
  version,
}: {
  detail: OrgDetail;
  admin: boolean;
  version: number;
}): preact.JSX.Element {
  const slug = detail.org.slug;
  const list = useLoad(
    () => api(`${memoryBase(slug)}/lessons?status=pending`, lessonListSchema),
    [slug, version],
  );
  return (
    <section aria-label="Lessons waiting for review">
      {!admin && <p class="muted">Only org admins can accept or reject lessons.</p>}
      <ErrorLine message={list.error} />
      {list.data?.length === 0 && <p class="muted">No lessons are waiting.</p>}
      <ul class="plain">
        {list.data?.map((l) => (
          <Lesson key={l.id} detail={detail} lesson={l} admin={admin} onDone={list.reload} />
        ))}
      </ul>
    </section>
  );
}
