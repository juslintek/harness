import type { LessonView } from "@shared/memory";
import { type OrgDetail, orgDetailSchema } from "@shared/orgs";
import { type JSX, Match, Show, Switch } from "solid-js";
import { me } from "../../auth/me";
import { createLoad, type Load } from "../../load";
import { routeParts } from "../../route";
import { Notice, State, Tabs } from "../../ui/molecules";
import { isAdmin } from "../orgs/shared";
import { LessonsPanel } from "./lessons-panel";
import { isMemoryMessage, lessonListSchema, memoryBase, tabOf, tabsFor } from "./memory-data";
import { NotesPane } from "./notes-pane";
import { WritesPanel } from "./writes-panel";
import "./memory.css";
import { ButtonLink, Help } from "../../ui/atoms";

const LABELS = { notes: "Notes", writes: "Writes", review: "Review" } as const;
const HELP = {
  notes:
    "Notes are short pages of text that agents can search and read with the memory tool. Agents write most of them during runs. People can write them too.",
  writes:
    "Every change to a note is recorded here with who made it and when. A write by an agent links to the run that made it. Revert puts the note back to its text before that write.",
  review:
    "A lesson is a tip an agent proposes after it finishes a task. Accept it and it becomes a note that agents can read. Reject it and it is dropped. Only admins decide.",
} as const;

function MemoryBody(props: {
  org: { id: string; slug: string };
  detail: OrgDetail;
  pending: Load<LessonView[]> | undefined;
}): JSX.Element {
  const topic = `org:${props.org.id}`;
  const tabs = (): ReturnType<typeof tabsFor> => tabsFor(props.detail.me.role);
  const tab = (): ReturnType<typeof tabOf> => tabOf(routeParts()[3], tabs());
  const waiting = (): number => props.pending?.data()?.length ?? 0;
  const admin = (): boolean => isAdmin(props.detail);
  const reviewHref = `#/o/${props.org.slug}/memory/review`;
  return (
    <>
      <Tabs
        label="Memory sections"
        current={tab()}
        items={tabs().map((key) => ({
          key,
          label: LABELS[key],
          href: `#/o/${props.org.slug}/memory/${key}`,
          ...(key === "review" && waiting() > 0
            ? { count: waiting(), countTone: "warning" as const }
            : {}),
        }))}
      />
      <Help>{HELP[tab()]}</Help>
      <Switch>
        <Match when={tab() === "notes"}>
          <Show when={admin() && waiting() > 0}>
            <Notice
              tone="warning"
              title={`${waiting()} ${waiting() === 1 ? "lesson from an agent is" : "lessons from agents are"} waiting for you`}
              actions={<ButtonLink href={reviewHref}>Review lessons</ButtonLink>}
            >
              An agent proposes a lesson after it finishes a task. It becomes a note only when you
              accept it.
            </Notice>
          </Show>
          <NotesPane detail={props.detail} topic={topic} selectedId={routeParts()[4]} />
        </Match>
        <Match when={tab() === "writes"}>
          <WritesPanel slug={props.org.slug} topic={topic} />
        </Match>
        <Match when={tab() === "review" && props.pending}>
          {(list) => <LessonsPanel detail={props.detail} admin={admin()} list={list()} />}
        </Match>
      </Switch>
    </>
  );
}

// Viewers get 403 from the lessons endpoint, so only members load the count.
function MemberBody(props: { org: { id: string; slug: string }; detail: OrgDetail }): JSX.Element {
  const pending = createLoad(
    () => `${memoryBase(props.org.slug)}/lessons?status=pending`,
    lessonListSchema,
    [`org:${props.org.id}`],
    isMemoryMessage,
  );
  return <MemoryBody {...props} pending={pending} />;
}

function Memory(props: { org: { id: string; slug: string } }): JSX.Element {
  const detail = createLoad(() => `/api/orgs/${props.org.slug}`, orgDetailSchema);
  return (
    <div class="memory">
      <Show when={detail.error()}>
        {(message) => (
          <State kind="error" message={message()} onRetry={() => void detail.reload()} />
        )}
      </Show>
      <Show when={detail.loading()}>
        <State kind="loading" />
      </Show>
      <Show when={detail.data()}>
        {(d) => (
          <Show
            when={d().me.role !== "viewer"}
            fallback={<MemoryBody org={props.org} detail={d()} pending={undefined} />}
          >
            <MemberBody org={props.org} detail={d()} />
          </Show>
        )}
      </Show>
    </div>
  );
}

export function MemoryPage(props: { slug: string }): JSX.Element {
  const org = (): { id: string; slug: string } | undefined =>
    me()?.orgs.find((o) => o.slug === props.slug);
  return (
    <Show when={org()} fallback={<State kind="empty" message="Org not found" />}>
      {(found) => <Memory org={found()} />}
    </Show>
  );
}
