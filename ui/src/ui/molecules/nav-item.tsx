import { type JSX, Show } from "solid-js";
import { CountBadge } from "../atoms";
import "./nav-item.css";

export function NavItem(props: {
  href: string;
  label: string;
  active: boolean;
  count?: number | undefined;
  countTone?: "neutral" | "warning";
  onNavigate: () => void;
}): JSX.Element {
  return (
    <a
      class="nav-item"
      href={props.href}
      aria-current={props.active ? "page" : undefined}
      onClick={() => props.onNavigate()}
    >
      {props.label}
      <Show when={props.count}>
        {(count) => (
          <>
            <CountBadge count={count()} tone={props.countTone ?? "neutral"} />
            <span class="sr-only"> waiting</span>
          </>
        )}
      </Show>
    </a>
  );
}
