import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Status } from "../../../shared/board";
import { STATUS_LABEL } from "./moves-client";

export const COLUMNS: Status[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
];

const optionId = (taskId: string, status: Status): string => `opt-${taskId}-${status}`;
const HANDLED = ["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape"];

function MoveList({
  taskId,
  current,
  onChoose,
  onClose,
}: {
  taskId: string;
  current: Status;
  onChoose: (to: Status) => void;
  onClose: () => void;
}): preact.JSX.Element {
  const [active, setActive] = useState(Math.max(0, COLUMNS.indexOf(current)));
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => list.current?.focus(), []);
  const onKey = (e: KeyboardEvent): void => {
    if (!HANDLED.includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "ArrowDown") setActive((i) => (i + 1) % COLUMNS.length);
    else if (e.key === "ArrowUp") setActive((i) => (i + COLUMNS.length - 1) % COLUMNS.length);
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(COLUMNS.length - 1);
    else if (e.key === "Escape") onClose();
    else onChoose(COLUMNS[active] ?? current);
  };
  return (
    <div
      class="move-list"
      role="listbox"
      aria-label="Move to"
      tabIndex={-1}
      ref={list}
      aria-activedescendant={optionId(taskId, COLUMNS[active] ?? current)}
      onKeyDown={onKey}
      onBlur={onClose}
    >
      {COLUMNS.map((status, i) => (
        <div
          key={status}
          id={optionId(taskId, status)}
          role="option"
          tabIndex={-1}
          aria-selected={status === current}
          data-active={i === active}
          onMouseDown={(e) => {
            e.preventDefault();
            onChoose(status);
          }}
        >
          {STATUS_LABEL[status]}
        </div>
      ))}
    </div>
  );
}

export function MoveMenu({
  taskId,
  current,
  onMove,
}: {
  taskId: string;
  current: Status;
  onMove: (to: Status) => void;
}): preact.JSX.Element {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = (): void => setOpen(false);
  return (
    <span class="move-menu">
      <button
        type="button"
        class="move-btn"
        ref={button}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        Move to…
      </button>
      {open && (
        <MoveList
          taskId={taskId}
          current={current}
          onClose={() => {
            close();
            button.current?.focus();
          }}
          onChoose={(to) => {
            close();
            button.current?.focus();
            if (to !== current) onMove(to);
          }}
        />
      )}
    </span>
  );
}
