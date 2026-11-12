import { approvalViewSchema } from "@shared/runs";
import { createSignal, type JSX, onCleanup, type ParentProps, Show } from "solid-js";
import { z } from "zod";
import { canDecideApprovals, me } from "../auth/me";
import { createLoad } from "../load";
import { Dialog } from "../ui/primitives";
import { HaltSwitch } from "./halt-switch";
import { pageTitle } from "./nav";
import { Sidebar } from "./sidebar";

const NARROW = "(max-width: 47.99rem)";
const approvalList = z.array(approvalViewSchema);

// Same list and topic as the pending-approvals page, so the count and the page agree.
function createPendingCount(): () => number {
  const current = me();
  const list =
    current && canDecideApprovals(current)
      ? createLoad("/api/approvals?status=pending", approvalList, ["approvals"])
      : null;
  return () => list?.data()?.length ?? 0;
}

export function AppShell(props: ParentProps): JSX.Element {
  const [drawer, setDrawer] = createSignal(false);
  const pending = createPendingCount();
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
      <div class="shell-side">
        <Sidebar pending={pending} onNavigate={close} />
      </div>
      <Dialog open={drawer()} onClose={close} label="Navigation" class="drawer">
        <Sidebar pending={pending} onNavigate={close} />
      </Dialog>
      <div class="shell-main">
        <header class="topbar">
          <button
            type="button"
            class="menu-button"
            aria-label="Open navigation"
            aria-expanded={drawer()}
            onClick={() => setDrawer(true)}
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none">
              <path d="M2 4 H14 M2 8 H14 M2 12 H14" />
            </svg>
          </button>
          <h1 class="topbar-title">{pageTitle()}</h1>
          <Show when={me()?.user.instanceAdmin}>
            <HaltSwitch />
          </Show>
        </header>
        <main id="content" ref={content} tabindex="-1">
          {props.children}
        </main>
      </div>
    </div>
  );
}
