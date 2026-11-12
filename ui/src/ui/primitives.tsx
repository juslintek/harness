import {
  createEffect,
  createUniqueId,
  type JSX,
  type ParentProps,
  Show,
  splitProps,
} from "solid-js";

export function Button(
  props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
    tone?: "primary" | "secondary" | "danger" | "ghost";
    size?: "sm" | "md";
  },
): JSX.Element {
  const [own, rest] = splitProps(props, ["tone", "size", "class", "type"]);
  return (
    <button
      type={own.type ?? "button"}
      class={own.class ? `btn ${own.class}` : "btn"}
      data-tone={own.tone ?? "secondary"}
      data-size={own.size ?? "md"}
      {...rest}
    />
  );
}

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

// The word is the enum value itself; the tone only adds colour to it.
export function StatusBadge(props: { tone: Tone; value: string }): JSX.Element {
  return (
    <span class="badge" data-tone={props.tone}>
      {props.value}
    </span>
  );
}

export interface FieldControl {
  id: string;
  "aria-invalid"?: "true";
  "aria-describedby"?: string;
}

// The control is passed in so one Field serves input, select and textarea alike.
export function Field(props: {
  label: string;
  error?: string | null | undefined;
  children: (control: () => FieldControl) => JSX.Element;
}): JSX.Element {
  const id = createUniqueId();
  const control = (): FieldControl =>
    props.error ? { id, "aria-invalid": "true", "aria-describedby": `${id}-error` } : { id };
  return (
    <div class="field">
      <label for={id}>{props.label}</label>
      {props.children(control)}
      <Show when={props.error}>
        {(message) => (
          <span id={`${id}-error`} class="field-error">
            {message()}
          </span>
        )}
      </Show>
    </div>
  );
}

export function Switch(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  ariaLabel?: string;
  tone?: "danger";
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      class="switch"
      aria-checked={props.checked}
      aria-label={props.label ? undefined : props.ariaLabel}
      data-tone={props.tone}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="switch-track" aria-hidden="true" />
      {props.label}
    </button>
  );
}

export function Panel(props: ParentProps<{ title: string; actions?: JSX.Element }>): JSX.Element {
  const id = createUniqueId();
  return (
    <section class="panel" aria-labelledby={id}>
      <header class="panel-head">
        <h2 id={id} class="panel-title">
          {props.title}
        </h2>
        <Show when={props.actions}>
          <div class="panel-actions">{props.actions}</div>
        </Show>
      </header>
      <div class="panel-body">{props.children}</div>
    </section>
  );
}

// Native <dialog>: showModal gives the focus trap, Escape, the inert page behind it and the return
// of focus to the opener. `open` is the parent's state; onClose fires for every way it closes.
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
  createEffect(() => {
    if (props.open && !dialog.open) dialog.showModal();
    else if (!props.open && dialog.open) dialog.close();
  });
  return (
    <dialog
      ref={dialog}
      class={props.class ?? "dialog"}
      aria-labelledby={props.title ? titleId : undefined}
      aria-label={props.label}
      onClose={() => props.onClose()}
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

const ROLES = { loading: "status", empty: undefined, error: "alert" } as const;

export function State(props: {
  kind: "loading" | "empty" | "error";
  title?: string;
  message?: string;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div class="state" data-kind={props.kind} role={ROLES[props.kind]}>
      <Show when={props.title}>
        <p class="state-title">{props.title}</p>
      </Show>
      <p>{props.message ?? (props.kind === "loading" ? "Loading…" : "")}</p>
      <Show when={props.kind === "error" && props.onRetry}>
        {(retry) => <Button onClick={() => retry()()}>Retry</Button>}
      </Show>
    </div>
  );
}
