import { createUniqueId, For, type JSX, type ParentProps } from "solid-js";
import { me } from "../../auth/me";
import { NavItem, OrgSwitcher } from "../molecules";
import { currentKey, navGroups } from "./nav";
import "./sidebar.css";

export type NavCounts = Partial<Record<string, number>>;

// Rendered twice: once in the page's left column, once in the drawer. CSS shows one at a time.
// `footer` is the drawer's stop or resume button.
export function Sidebar(
  props: ParentProps<{ counts: () => NavCounts; onNavigate: () => void }>,
): JSX.Element {
  return (
    <nav class="sidebar" aria-label="Main">
      <OrgSwitcher onNavigate={props.onNavigate} />
      <div class="nav-groups">
        <For each={navGroups()}>
          {(group) => {
            const id = createUniqueId();
            return (
              <div class="nav-group">
                {group.title && (
                  <p id={id} class="nav-heading">
                    {group.title}
                  </p>
                )}
                <ul
                  aria-labelledby={group.title ? id : undefined}
                  aria-label={group.title ? undefined : "Now"}
                >
                  <For each={group.items}>
                    {(item) => (
                      <li>
                        <NavItem
                          href={item.href}
                          label={item.label}
                          active={currentKey() === item.key}
                          count={props.counts()[item.key]}
                          countTone={item.key === "approvals" ? "warning" : "neutral"}
                          onNavigate={props.onNavigate}
                        />
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            );
          }}
        </For>
      </div>
      <div class="sidebar-foot">
        {props.children}
        <NavItem
          href="#/account"
          label="Account"
          active={currentKey() === "account"}
          onNavigate={props.onNavigate}
        />
        <p class="signed-in">{me()?.user.email}</p>
      </div>
    </nav>
  );
}
