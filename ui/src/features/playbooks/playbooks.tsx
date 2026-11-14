import { orgDetailSchema } from "@shared/orgs";
import { For, type JSX, Match, Show, Switch } from "solid-js";
import { createLoad } from "../../load";
import { selectedSlug } from "../../orgs";
import { routeParts } from "../../route";
import { ButtonLink, StatusBadge } from "../../ui/atoms";
import { Notice, Panel } from "../../ui/molecules";
import { MarketingKindSection } from "./marketing-kind";
import { PlaybookCard } from "./playbook-card";
import { hrefFor } from "./playbook-links";
import { GROUPS, INTRO, MARKETING, MARKETING_KINDS } from "./playbooks-data";
import "./playbooks.css";

function Index(): JSX.Element {
  return (
    <For each={GROUPS}>
      {(group) => (
        <section class="pb-group" aria-labelledby={`pbg-${group.cards[0]?.id}`}>
          <h2 id={`pbg-${group.cards[0]?.id}`}>{group.title}</h2>
          <p class="pb-muted">{group.help}</p>
          <div class="pb-grid">
            <For each={group.cards}>{(card) => <PlaybookCard playbook={card} />}</For>
          </div>
        </section>
      )}
    </For>
  );
}

function Marketing(): JSX.Element {
  const hire = (): string | null => hrefFor("hire-writing");
  const slug = selectedSlug;
  const org = createLoad(() => `/api/orgs/${slug() ?? "-"}`, orgDetailSchema);
  // A task link can carry the title only when it is clear which project it is for.
  const project = (): string | undefined =>
    org.data()?.projects.length === 1 ? org.data()?.projects[0]?.id : undefined;
  return (
    <>
      <header class="pb-head">
        <div class="pb-intro">
          <div class="pb-title">
            <h2>{MARKETING.title}</h2>
            <StatusBadge tone="info" value={INTRO.title} />
          </div>
          <p class="pb-muted">{MARKETING.lead}</p>
        </div>
        <Show when={hire()}>
          {(href) => (
            <ButtonLink tone="primary" href={href()}>
              Hire a writing agent
            </ButtonLink>
          )}
        </Show>
      </header>
      <Notice tone="warning" standing title={MARKETING.limits.title}>
        {MARKETING.limits.body}
      </Notice>
      <Panel title={MARKETING.howTitle}>
        <ol class="pb-how">
          <For each={MARKETING.how}>
            {(step) => (
              <li>
                <strong>{step.title}.</strong> {step.body}
              </li>
            )}
          </For>
        </ol>
      </Panel>
      <section class="pb-group" aria-labelledby="pb-kinds">
        <h2 id="pb-kinds">Kinds of marketing</h2>
        <p class="pb-muted">{MARKETING.taskNote}</p>
        <For each={MARKETING_KINDS}>
          {(kind) => (
            <MarketingKindSection kind={kind} toolsNote={MARKETING.toolsNote} project={project()} />
          )}
        </For>
      </section>
    </>
  );
}

export function PlaybooksPage(): JSX.Element {
  return (
    <div class="pb">
      <Show when={routeParts()[1] !== "marketing"}>
        <Notice tone="info" title={INTRO.title}>
          {INTRO.body}
        </Notice>
      </Show>
      <Switch fallback={<Index />}>
        <Match when={routeParts()[1] === "marketing"}>
          <Marketing />
        </Match>
      </Switch>
    </div>
  );
}
