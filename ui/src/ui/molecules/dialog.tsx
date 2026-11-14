import { createEffect, createUniqueId, type JSX, type ParentProps, Show } from "solid-js";
import "./dialog.css";

// Native <dialog>: showModal gives the focus trap, Escape, the inert page behind it and the return
// of focus to the opener. `open` is the parent's state; onClose fires for every way it closes.
// `footer` is the actions row (Recto's "actions" slot).
export function Dialog(
  props: ParentProps<{
    open: boolean;
    onClose: () => void;
    title?: string;
    label?: string;
    footer?: JSX.Element;
    class?: string;
  }>,
): JSX.Element {
  let dialog!: HTMLDialogElement;
  const titleId = createUniqueId();
  // Escape closes the element at once but its close event is queued. `cancel` is synchronous, so the
  // parent's state is already false when the dialog is opened again; a stale close event that
  // arrives after that finds the element open again and is ignored.
  const closed = (): void => {
    if (!dialog.open && props.open) props.onClose();
  };
  const cancelled = (): void => {
    if (props.open) props.onClose();
  };
  createEffect(() => {
    if (props.open && !dialog.open) {
      // Opened from the start (a deep link), the effect runs before the element is in the page.
      if (dialog.isConnected) dialog.showModal();
      else
        queueMicrotask(() => {
          if (props.open && dialog.isConnected && !dialog.open) dialog.showModal();
        });
    } else if (!props.open && dialog.open) dialog.close();
  });
  return (
    <dialog
      ref={dialog}
      class={props.class ?? "dialog"}
      aria-labelledby={props.title ? titleId : undefined}
      aria-label={props.label}
      onCancel={cancelled}
      onClose={closed}
      onPointerDown={(e) => {
        if (e.target === dialog) dialog.close();
      }}
    >
      <Show when={props.title} fallback={props.children}>
        {(title) => (
          <>
            <h2 id={titleId} class="dialog-title">
              {title()}
            </h2>
            <div class="dialog-body">{props.children}</div>
            <Show when={props.footer}>
              <div class="dialog-footer">{props.footer}</div>
            </Show>
          </>
        )}
      </Show>
    </dialog>
  );
}
