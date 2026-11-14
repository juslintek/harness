import { For, type JSX, Show } from "solid-js";
import { ButtonLink, CopyButton, StatusBadge } from "../../ui/atoms";
import { hrefFor } from "./playbook-links";
import type { MarketingKind } from "./playbooks-data";

export function MarketingKindSection(props: {
  kind: MarketingKind;
  toolsNote: string;
  // The one project of the organisation, when there is exactly one.
  project: string | undefined;
}): JSX.Element {
  const id = (): string => `mk-${props.kind.name.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  const board = (): string | null => {
    const href = hrefFor("board");
    return href && props.project
      ? `${href}/${props.project}?new=1&title=${encodeURIComponent(props.kind.task.title)}`
      : href;
  };
  return (
    <section class="pb-kind" aria-labelledby={id()}>
      <h3 id={id()}>{props.kind.name}</h3>
      <p class="pb-muted">{props.kind.blurb}</p>
      <div class="pb-kind-cols">
        <div>
          <h4>An agent can, today</h4>
          <ul>
            <For each={props.kind.can}>{(line) => <li>{line}</li>}</For>
          </ul>
        </div>
        <div>
          <h4>An agent cannot</h4>
          <ul>
            <For each={props.kind.cannot}>{(line) => <li>{line}</li>}</For>
          </ul>
        </div>
        <div>
          <h4>Outside tools people use</h4>
          <ul>
            <For each={props.kind.tools}>
              {(tool) => (
                <li>
                  {tool} <span class="pb-muted">· {props.toolsNote}</span>
                </li>
              )}
            </For>
          </ul>
        </div>
      </div>
      <footer class="pb-kind-foot">
        <div class="pb-task">
          <span class="pb-muted">Suggested first task</span>
          <strong>{props.kind.task.title}</strong>
        </div>
        <div class="pb-kind-acts">
          <span class="pb-muted">Type</span>
          <StatusBadge tone="neutral" value={props.kind.task.type} />
          <CopyButton text={props.kind.task.title} label={"Copy title"} />
          <Show when={board()}>
            {(href) => (
              <ButtonLink href={href()}>
                {props.project ? "Create task from this" : "Open Board to add it"}
              </ButtonLink>
            )}
          </Show>
        </div>
      </footer>
    </section>
  );
}
