import { type JSX, type ParentProps, Show } from "solid-js";
import "./notice.css";

// Banners, results of an action and inline help. Info and success are polite; warning and danger
// are announced at once. A `standing` notice is part of the page from the start, so it is not
// news and has no live role.
export function Notice(
  props: ParentProps<{
    tone: "info" | "success" | "warning" | "danger";
    title?: string;
    actions?: JSX.Element;
    // Full width, no radius: the halted banner under the top bar.
    banner?: boolean;
    standing?: boolean;
  }>,
): JSX.Element {
  return (
    <div
      class="notice"
      data-tone={props.tone}
      data-banner={props.banner ? "" : undefined}
      role={
        props.standing
          ? undefined
          : props.banner || props.tone === "info" || props.tone === "success"
            ? "status"
            : "alert"
      }
    >
      <div class="notice-text">
        <Show when={props.title}>
          <div class="notice-title">{props.title}</div>
        </Show>
        <div class="notice-body">{props.children}</div>
      </div>
      <Show when={props.actions}>
        <div class="notice-actions">{props.actions}</div>
      </Show>
    </div>
  );
}
