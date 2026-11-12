import { createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import { me } from "../auth/me";
import { chooseOrg, selectedSlug } from "../orgs";
import { currentKey, navGroups } from "./nav";

function OrgSwitcher(props: { onNavigate: () => void }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const menuId = createUniqueId();
  let trigger!: HTMLButtonElement;
  const orgs = (): NonNullable<ReturnType<typeof me>>["orgs"] => me()?.orgs ?? [];
  const current = () => orgs().find((o) => o.slug === selectedSlug());
  const pick = (slug: string): void => {
    setOpen(false);
    trigger.focus();
    chooseOrg(slug);
    props.onNavigate();
  };
  return (
    <Show when={current()}>
      {(org) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: these only watch focus and Escape for the menu inside
        <div
          class="org-switcher"
          onFocusOut={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Escape" || !open()) return;
            // Without this the Escape would also close the drawer the menu sits in.
            e.preventDefault();
            setOpen(false);
            trigger.focus();
          }}
        >
          <button
            ref={trigger}
            type="button"
            class="org-trigger"
            aria-haspopup="menu"
            aria-expanded={open()}
            aria-controls={menuId}
            onClick={() => setOpen(!open())}
          >
            <span class="org-text">
              <span class="org-name">{org().name}</span>
              <span class="org-role">{org().role}</span>
            </span>
            <svg aria-hidden="true" viewBox="0 0 12 12" width="12" height="12" fill="none">
              <path d="M3 4.5 L6 7.5 L9 4.5" />
            </svg>
          </button>
          <Show when={open()}>
            <div id={menuId} class="org-menu" role="menu" aria-label="Organisations">
              <For each={orgs()}>
                {(o) => (
                  <button
                    type="button"
                    role="menuitem"
                    class="org-option"
                    aria-current={o.slug === org().slug ? "true" : undefined}
                    // Keeps focus on the trigger so Safari's click is not lost to the focusout above.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(o.slug)}
                  >
                    <span>{o.name}</span>
                    <Show when={o.slug === org().slug}>
                      <span class="org-current">Current</span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}

function Item(props: {
  href: string;
  active: boolean;
  onNavigate: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <a
      class="nav-item"
      href={props.href}
      aria-current={props.active ? "page" : undefined}
      onClick={() => props.onNavigate()}
    >
      {props.children}
    </a>
  );
}

// Rendered twice: once in the page's left column, once in the drawer. CSS shows one at a time.
export function Sidebar(props: { pending: () => number; onNavigate: () => void }): JSX.Element {
  return (
    <nav class="sidebar" aria-label="Main">
      <OrgSwitcher onNavigate={props.onNavigate} />
      <div class="nav-groups">
        <For each={navGroups()}>
          {(group) => {
            const id = createUniqueId();
            return (
              <div class="nav-group">
                <p id={id} class="nav-heading">
                  {group.title}
                </p>
                <ul aria-labelledby={id}>
                  <For each={group.items}>
                    {(item) => (
                      <li>
                        <Item
                          href={item.href}
                          active={currentKey() === item.key}
                          onNavigate={props.onNavigate}
                        >
                          {item.label}
                          <Show when={item.key === "approvals" && props.pending() > 0}>
                            <span class="count">{props.pending()}</span>
                            <span class="sr-only"> pending</span>
                          </Show>
                        </Item>
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
        <Item href="#/account" active={currentKey() === "account"} onNavigate={props.onNavigate}>
          Account
        </Item>
        <p class="signed-in">{me()?.user.email}</p>
      </div>
    </nav>
  );
}
