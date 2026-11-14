import { For, type JSX } from "solid-js";
import { ButtonLink } from "../../ui/atoms";
import type { NowData } from "./now-data";

interface Item {
  label: string;
  done: boolean;
  href: string;
  action: string;
}

// Shown instead of the blocks while the organisation has no agent or no project. Only steps the
// server can tell are listed.
export function FirstRun(props: { data: NowData; slug: string; name: string }): JSX.Element {
  const d = (): NowData => props.data;
  const home = `#/o/${props.slug}`;
  const items = (): Item[] => {
    const detail = d().detail.data();
    const members = detail?.members ?? [];
    return [
      {
        label: "Create a project",
        done: (detail?.projects.length ?? 0) > 0,
        href: `${home}/settings`,
        action: "Open Settings",
      },
      {
        label: "Add an agent",
        done: members.some((m) => m.kind === "agent"),
        href: `${home}/hiring`,
        action: "Start hiring",
      },
      {
        label: "Set a monthly budget",
        done: d()
          .budgets()
          .some((b) => b.scopeKind === "org"),
        href: `${home}/policies`,
        action: "Open Policies",
      },
      {
        label: "Invite your team",
        done: members.filter((m) => m.kind === "human").length > 1,
        href: `${home}/settings`,
        action: "Open Members",
      },
      {
        label: "Add a second passkey",
        done: (d().passkeys?.data()?.length ?? 0) > 1,
        href: "#/account",
        action: "Open Account",
      },
      {
        label: "Choose where you get notified",
        done: (d().targets?.data()?.length ?? 0) > 0,
        href: "#/account",
        action: "Open Account",
      },
    ];
  };
  const current = (): number => items().findIndex((i) => !i.done);
  return (
    <section class="now-first-run" aria-labelledby="now-first-run-title">
      <h2 id="now-first-run-title" class="now-heading">
        Set up {props.name}
      </h2>
      <ol class="now-steps" aria-label="Setup steps">
        <For each={items()}>
          {(item, i) => (
            <li
              class="now-step"
              data-state={item.done ? "done" : i() === current() ? "current" : "todo"}
            >
              <span class="now-step-mark" aria-hidden="true">
                {item.done ? "✓" : i() + 1}
              </span>
              <span class="now-step-label">
                {item.label}
                {item.done ? <span class="sr-only"> (done)</span> : null}
              </span>
              {item.done ? (
                <span class="now-step-done">done</span>
              ) : (
                <ButtonLink href={item.href} tone={i() === current() ? "primary" : "secondary"}>
                  {item.action}
                </ButtonLink>
              )}
            </li>
          )}
        </For>
      </ol>
    </section>
  );
}
