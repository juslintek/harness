import type { JSX, ParentProps } from "solid-js";
import "./button.css";

// A link that looks like a button: a click is navigation, so it stays an anchor.
export function ButtonLink(
  props: ParentProps<{
    href: string;
    tone?: "primary" | "secondary" | "ghost";
    size?: "sm" | "md";
  }>,
): JSX.Element {
  return (
    <a
      class="btn"
      data-tone={props.tone ?? "secondary"}
      data-size={props.size ?? "md"}
      href={props.href}
    >
      {props.children}
    </a>
  );
}
