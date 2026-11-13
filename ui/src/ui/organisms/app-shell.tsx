import { createMemo, createSignal, type JSX, onCleanup, type ParentProps, Show } from "solid-js";
import { me } from "../../auth/me";
import { selectedSlug } from "../../orgs";
import { AgentsToggle, ConfirmDialog, Dialog, Notice } from "../molecules";
import { createHalt } from "./halt";
import { NavCountsSource } from "./nav-counts";
import { type NavCounts, Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";
import "./app-shell.css";

const NARROW = "(max-width: 47.99rem)";

export function AppShell(props: ParentProps): JSX.Element {
  const [drawer, setDrawer] = createSignal(false);
  const [counts, setCounts] = createSignal<NavCounts>({});
  const [asking, setAsking] = createSignal(false);
  const halt = createHalt();
  const org = createMemo(() => me()?.orgs.find((o) => o.slug === selectedSlug()));
  let content!: HTMLElement;
  // A drawer left open while the window grows would keep the page behind it inert.
  const narrow = matchMedia(NARROW);
  const closeWhenWide = (): void => {
    if (!narrow.matches) setDrawer(false);
  };
  narrow.addEventListener("change", closeWhenWide);
  onCleanup(() => narrow.removeEventListener("change", closeWhenWide));
  const close = (): void => {
    setDrawer(false);
  };
  // Stopping asks first; resuming only needs the passkey the server asks for.
  const toggle = (): void => {
    if (halt.halted()) void halt.toggle();
    else setAsking(true);
  };
  const sidebar = (
    <Sidebar counts={counts} onNavigate={close}>
      <Show when={halt.halted() !== undefined}>
        <AgentsToggle halted={halt.halted() === true} onToggle={toggle} />
      </Show>
    </Sidebar>
  );
  return (
    <div class="shell">
      {/* biome-ignore lint/a11y/useValidAnchor: a plain "#content" jump would change the hash route */}
      <a
        class="skip"
        href="#content"
        onClick={(e) => {
          e.preventDefault();
          content.focus();
        }}
      >
        Skip to content
      </a>
      <Show when={org()} keyed>
        {(o) => <NavCountsSource org={o} onChange={setCounts} />}
      </Show>
      <div class="shell-side">
        <Sidebar counts={counts} onNavigate={close} />
      </div>
      <Dialog open={drawer()} onClose={close} label="Navigation" class="drawer">
        {sidebar}
      </Dialog>
      <div class="shell-main">
        <TopBar
          drawerOpen={drawer()}
          onMenu={() => setDrawer(true)}
          halt={halt}
          onToggleHalt={toggle}
        />
        <Show when={halt.halted()}>
          <Notice tone="warning" banner standing title="All agents are stopped">
            No run will start until an instance admin resumes them.
          </Notice>
        </Show>
        <main id="content" ref={content} tabindex="-1">
          {props.children}
        </main>
      </div>
      <ConfirmDialog
        open={asking()}
        title="Stop all agents?"
        message="Every running run is stopped now and no new run starts until you resume agents. Your passkey is asked next."
        confirm="Stop all agents"
        onClose={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          void halt.toggle();
        }}
      />
    </div>
  );
}
