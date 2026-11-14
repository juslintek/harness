import { createUniqueId, type JSX, type ParentProps } from "solid-js";
import { CountBadge } from "../../ui/atoms";

export function NowSection(
  props: ParentProps<{ title: string; count?: number; tone?: "neutral" | "warning" }>,
): JSX.Element {
  const id = createUniqueId();
  return (
    <section class="now-section" aria-labelledby={id}>
      <h2 id={id} class="now-heading">
        {props.title}
        {props.count === undefined ? null : (
          <CountBadge count={props.count} tone={props.tone ?? "neutral"} />
        )}
      </h2>
      {props.children}
    </section>
  );
}
