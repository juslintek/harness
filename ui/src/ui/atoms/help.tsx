import type { JSX, ParentProps } from "solid-js";
import "./help.css";

export function Help(props: ParentProps<{ small?: boolean }>): JSX.Element {
  return (
    <p class="help" data-size={props.small ? "small" : undefined}>
      {props.children}
    </p>
  );
}
