import { useState } from "preact/hooks";
import { api, useLoad } from "../../api";
import { fmtTime } from "../../format";
import { ErrorLine } from "../auth/error-line";
import { useAction } from "../auth/use-action";
import { lineDiff } from "./line-diff";
import {
  memoryBase,
  shownPath,
  type WriteWithText,
  writeListSchema,
  writeResultSchema,
} from "./memory-data";

function Revert({
  slug,
  id,
  onDone,
}: {
  slug: string;
  id: string;
  onDone: () => void;
}): preact.JSX.Element {
  const [asking, setAsking] = useState(false);
  const action = useAction();
  const confirm = (): void => {
    action
      .run(async () => {
        await api(`${memoryBase(slug)}/writes/${id}/revert`, writeResultSchema, { method: "POST" });
        setAsking(false);
        onDone();
      })
      .catch((err: unknown) => console.error(err));
  };
  if (!asking) {
    return (
      <button type="button" onClick={() => setAsking(true)}>
        Revert
      </button>
    );
  }
  return (
    <div class="row">
      <span>Put the note back to the text before this write?</span>
      <button type="button" class="danger" disabled={action.busy} onClick={confirm}>
        Confirm revert
      </button>
      <button type="button" onClick={() => setAsking(false)}>
        Cancel
      </button>
      <ErrorLine message={action.error} />
    </div>
  );
}

function Diff({ write }: { write: WriteWithText }): preact.JSX.Element {
  const rows = lineDiff(write.before ?? "", write.after ?? "");
  return (
    <pre class="diff">
      {rows.map((r, i) => (
        <span key={i} class={`diff-${r.op === "+" ? "add" : r.op === "-" ? "del" : "same"}`}>
          {r.op} {r.line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function WriteItem({
  slug,
  write,
  onDone,
}: {
  slug: string;
  write: WriteWithText;
  onDone: () => void;
}): preact.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <li class="card">
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          {write.op} {shownPath(write.path)} by {write.actor}, {fmtTime(write.at)}
        </summary>
        {open && <Diff write={write} />}
      </details>
      {write.op !== "outside" && <Revert slug={slug} id={write.id} onDone={onDone} />}
    </li>
  );
}

export function WritesPanel({
  slug,
  version,
}: {
  slug: string;
  version: number;
}): preact.JSX.Element {
  const [agentsOnly, setAgentsOnly] = useState(false);
  const list = useLoad(
    () =>
      api(`${memoryBase(slug)}/writes?agentsOnly=${agentsOnly ? 1 : 0}&limit=50`, writeListSchema),
    [slug, agentsOnly, version],
  );
  return (
    <section aria-label="Recent writes">
      <label class="inline">
        <input
          type="checkbox"
          checked={agentsOnly}
          onChange={(e) => setAgentsOnly(e.currentTarget.checked)}
        />
        Agent writes only
      </label>
      <ErrorLine message={list.error} />
      {list.data?.length === 0 && <p class="muted">No writes yet.</p>}
      <ul class="plain">
        {list.data?.map((w) => (
          <WriteItem key={w.id} slug={slug} write={w} onDone={list.reload} />
        ))}
      </ul>
    </section>
  );
}
