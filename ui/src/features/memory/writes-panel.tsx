import type { NoteWriteFeedItem } from "@shared/memory";
import { createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { Button, State, StatusBadge } from "../../ui/primitives";
import { lineDiff } from "./line-diff";
import {
  isMemoryMessage,
  memoryBase,
  shownPath,
  writeListSchema,
  writeResultSchema,
} from "./memory-data";

function Revert(props: { slug: string; id: string; onDone: () => void }): JSX.Element {
  const [asking, setAsking] = createSignal(false);
  const action = createAction();
  const confirm = (): void => {
    void action.run(async () => {
      await api(`${memoryBase(props.slug)}/writes/${props.id}/revert`, writeResultSchema, {
        method: "POST",
      });
      setAsking(false);
      props.onDone();
    });
  };
  return (
    <Show
      when={asking()}
      fallback={
        <Button size="sm" onClick={() => setAsking(true)}>
          Revert
        </Button>
      }
    >
      <div class="memory-actions">
        <span>Put the note back to the text before this write?</span>
        <Button size="sm" tone="danger" disabled={action.busy()} onClick={confirm}>
          Confirm revert
        </Button>
        <Button size="sm" onClick={() => setAsking(false)}>
          Cancel
        </Button>
      </div>
      <Show when={action.error()}>
        {(message) => (
          <p class="memory-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
    </Show>
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
  const [open, setOpen] = createSignal(false);
  return (
    <li class="memory-card">
      <details open={open()} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary class="memory-summary">
          <StatusBadge tone="neutral" value={props.write.op} />{" "}
          <span class="memory-line">{shownPath(props.write.path)}</span> by {props.write.actor},{" "}
          {new Date(props.write.at).toLocaleString()}
        </summary>
        <Show when={open()}>
          <Diff write={props.write} />
        </Show>
      </details>
      <Show when={props.write.canRevert}>
        <Revert slug={props.slug} id={props.write.id} onDone={props.onDone} />
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
    <section class="memory-stack" aria-label="Recent writes">
      <label class="memory-check">
        <input
          type="checkbox"
          checked={agentsOnly()}
          onChange={(e) => setAgentsOnly(e.currentTarget.checked)}
        />
        Agent writes only
      </label>
      <Show when={list.error()}>
        {(message) => <State kind="error" message={message()} onRetry={() => void list.reload()} />}
      </Show>
      <Show when={list.data()?.length === 0}>
        <State kind="empty" message="No writes yet." />
      </Show>
      <ul class="memory-plain">
        <For each={list.data()}>
          {(w) => <WriteItem slug={props.slug} write={w} onDone={() => void list.reload()} />}
        </For>
      </ul>
    </section>
  );
}
