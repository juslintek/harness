import { orgDetailSchema } from "@shared/orgs";
import { type JSX, Match, Show, Switch } from "solid-js";
import { me } from "../../auth/me";
import { createLoad } from "../../load";
import { routeParts } from "../../route";
import { State, Tabs } from "../../ui/molecules";
import { BridgeSettings } from "../bridge/bridge-settings";
import { Members } from "./members";
import { isAdmin } from "./shared";
import { Positions, Projects } from "./structure";
import { Teams } from "./teams";
import "./settings.css";

const SECTIONS = [
  { key: "members", label: "Members" },
  { key: "teams", label: "Teams" },
  { key: "positions", label: "Positions" },
  { key: "projects", label: "Projects" },
  { key: "bridges", label: "Bridges" },
] as const;

export function SettingsPage(props: { slug: string }): JSX.Element {
  const known = (): boolean => me()?.orgs.some((o) => o.slug === props.slug) ?? false;
  return (
    <Show when={known()} fallback={<State kind="empty" message="Org not found" />}>
      <SettingsBody slug={props.slug} />
    </Show>
  );
}

function SettingsBody(props: { slug: string }): JSX.Element {
  const org = createLoad(() => `/api/orgs/${props.slug}`, orgDetailSchema);
  return (
    <Show
      when={org.data()}
      fallback={
        <State
          kind={org.error() ? "error" : "loading"}
          {...(org.error()
            ? { message: org.error() as string, onRetry: () => void org.reload() }
            : {})}
        />
      }
    >
      {(detail) => {
        const sections = (): (typeof SECTIONS)[number][] =>
          SECTIONS.filter((x) => x.key !== "bridges" || isAdmin(detail()));
        const current = (): string => {
          const asked = routeParts()[3];
          return sections().find((x) => x.key === asked)?.key ?? "members";
        };
        const reload = (): void => void org.reload();
        return (
          <div class="settings">
            <h1 class="settings-title">
              {detail().org.name} <span class="settings-slug">{props.slug}</span>
            </h1>
            <Tabs
              label="Settings sections"
              current={current()}
              items={sections().map((x) => ({
                key: x.key,
                label: x.label,
                href: `#/o/${props.slug}/settings/${x.key}`,
              }))}
            />
            <Switch>
              <Match when={current() === "members"}>
                <Members detail={detail()} onChange={reload} />
              </Match>
              <Match when={current() === "teams"}>
                <Teams detail={detail()} onChange={reload} />
              </Match>
              <Match when={current() === "positions"}>
                <Positions detail={detail()} onChange={reload} />
              </Match>
              <Match when={current() === "projects"}>
                <Projects detail={detail()} onChange={reload} />
              </Match>
              <Match when={current() === "bridges"}>
                <BridgeSettings slug={props.slug} />
              </Match>
            </Switch>
          </div>
        );
      }}
    </Show>
  );
}
