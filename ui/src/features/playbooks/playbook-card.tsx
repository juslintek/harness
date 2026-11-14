import { For, type JSX, Show } from "solid-js";
import { ButtonLink } from "../../ui/atoms";
import { hrefFor } from "./playbook-links";
import type { Playbook } from "./playbooks-data";

export function PlaybookCard(props: { playbook: Playbook }): JSX.Element {
  const links = (): { label: string; href: string }[] =>
    props.playbook.actions.flatMap((a) => {
      const href = hrefFor(a.to);
      return href ? [{ label: a.label, href }] : [];
    });
  return (
    <article class="pb-card" aria-labelledby={`pb-${props.playbook.id}`}>
      <h3 id={`pb-${props.playbook.id}`}>{props.playbook.title}</h3>
      <p class="pb-when">{props.playbook.when}</p>
      <Show when={props.playbook.steps}>
        {(steps) => (
          <ol class="pb-steps">
            <For each={steps()}>{(step) => <li>{step}</li>}</For>
          </ol>
        )}
      </Show>
      <Show when={props.playbook.note}>
        <p class="pb-note">{props.playbook.note}</p>
      </Show>
      <div class="pb-actions">
        <For each={links()}>{(link) => <ButtonLink href={link.href}>{link.label}</ButtonLink>}</For>
      </div>
    </article>
  );
}
