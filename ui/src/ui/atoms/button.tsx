import { type JSX, splitProps } from "solid-js";
import "./button.css";

export function Button(
  props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
    tone?: "primary" | "secondary" | "danger" | "danger-quiet" | "ghost";
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
