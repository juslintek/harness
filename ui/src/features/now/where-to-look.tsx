import { For, type JSX } from "solid-js";
import { isViewerIn, me } from "../../auth/me";
import { Help } from "../../ui/atoms";
import { Panel } from "../../ui/molecules";

interface Place {
  question: string;
  label: string;
  href: string;
  note: string;
}

export function WhereToLook(props: { slug: string }): JSX.Element {
  const places = (): Place[] => {
    const current = me();
    const home = `#/o/${props.slug}`;
    return [
      ...(current?.user.instanceAdmin
        ? [
            {
              question: "Follow a run live",
              label: "Runs",
              href: "#/runs",
              note: "Open a running run and turn on Follow.",
            },
          ]
        : []),
      ...(current && !isViewerIn(current, props.slug)
        ? [
            {
              question: "What agents were allowed or refused",
              label: "Logs",
              href: `${home}/logs`,
              note: "Search the guard and tool events.",
            },
          ]
        : []),
      {
        question: "Spend and limits",
        label: "Usage & budgets",
        href: `${home}/dashboard`,
        note: "Cost by member, budgets and quota.",
      },
      {
        question: "What an agent remembers",
        label: "Memory",
        href: `${home}/memory`,
        note: "Notes agents read before they work.",
      },
    ];
  };
  return (
    <Panel title="Where to look">
      <ul class="now-places">
        <For each={places()}>
          {(p) => (
            <li>
              <p>
                {p.question} → <a href={p.href}>{p.label}</a>
              </p>
              <Help>{p.note}</Help>
            </li>
          )}
        </For>
      </ul>
    </Panel>
  );
}
