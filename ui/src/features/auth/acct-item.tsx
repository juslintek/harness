import type { JSX } from "solid-js";
import "./account.css";

// One line of an account list: what it is, when, and the action that belongs to it.
export function AcctItem(props: {
  title: JSX.Element;
  meta: JSX.Element;
  action: JSX.Element;
}): JSX.Element {
  return (
    <li class="acct-item">
      <span class="acct-text">
        {props.title}
        <span class="acct-meta">{props.meta}</span>
      </span>
      {props.action}
    </li>
  );
}
