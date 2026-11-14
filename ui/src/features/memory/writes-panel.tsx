import type { NoteWriteFeedItem } from "@shared/memory";
import { createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { Checkbox } from "../../ui/atoms";
import { ConfirmButton, Panel, State } from "../../ui/molecules";
import { lineDiff } from "./line-diff";
import {
  isMemoryMessage,
  memoryBase,
  shownPath,
  writeListSchema,
  writeResultSchema,
} from "./memory-data";
import { MemoryError } from "./memory-error";
import { WriteMeta } from "./write-meta";

function Revert(props: {
  slug: string;
  id: string;
  path: string;
  onDone: () => void;
}): JSX.Element {
  const action = createAction();
  const confirm = (): void => {
    void action.run(async () => {
      await api(`${memoryBase(props.slug)}/writes/${props.id}/revert`, writeResultSchema, {
        method: "POST",
      });
      props.onDone();
    });
  };
  return (
    <>
      <ConfirmButton
        size="sm"
        tone="secondary"
        text="Revert"
        title="Revert this write?"
        message={`The note ${shownPath(props.path)} goes back to the text it had before this write.`}
        confirm="Confirm revert"
        onConfirm={confirm}
      />
      <MemoryError message={action.error()} />
    </>
  );
}

function Diff(props: { write: NoteWriteFeedItem }): JSX.Element {
  const rows = (): ReturnType<typeof lineDiff> =>
    lineDiff(props.write.before ?? "", props.write.after ?? "");
  const cls = (op: string): string =>
    op === "+" ? "memory-diff-add" : op === "-" ? "memory-diff-del" : "memory-diff-same";
  return (
    <pre class="memory-diff">
      <For each={rows()}>
        {(r) => (
          <span class={cls(r.op)}>
            {r.op} {r.line}
            {"\n"}
          </span>
        )}
      </For>
    </pre>
  );
}

function WriteItem(props: {
  slug: string;
  write: NoteWriteFeedItem;
  onDone: () => void;
}): JSX.Element {
  return (
    <li class="memory-row">
      <div class="memory-row-head">
        <p class="memory-meta memory-summary">
          <WriteMeta write={props.write} withPath />
        </p>
        <Show when={props.write.canRevert}>
          <Revert
            slug={props.slug}
            id={props.write.id}
            path={props.write.path}
            onDone={props.onDone}
          />
        </Show>
      </div>
      <Show when={props.write.op === "update" || props.write.op === "revert"}>
        <Diff write={props.write} />
      </Show>
    </li>
  );
}

export function WritesPanel(props: { slug: string; topic: string }): JSX.Element {
  const [agentsOnly, setAgentsOnly] = createSignal(false);
  const list = createLoad(
    () => `${memoryBase(props.slug)}/writes?agentsOnly=${agentsOnly() ? 1 : 0}&limit=50`,
    writeListSchema,
    [props.topic],
    isMemoryMessage,
  );
  return (
    <Panel title="Recent writes">
      <section class="memory-stack" aria-label="Recent writes">
        <Checkbox
          checked={agentsOnly()}
          onChange={setAgentsOnly}
          label="Show only writes by agents"
        />
        <Show when={list.error()}>
          {(message) => (
            <State kind="error" message={message()} onRetry={() => void list.reload()} />
          )}
        </Show>
        <Show when={list.data()?.length === 0}>
          <State
            kind="empty"
            message="No writes yet. Every change to a note, by a person or an agent, is listed here."
          />
        </Show>
        <ul class="memory-plain">
          <For each={list.data()}>
            {(w) => <WriteItem slug={props.slug} write={w} onDone={() => void list.reload()} />}
          </For>
        </ul>
      </section>
    </Panel>
  );
}
