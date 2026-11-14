import { type JSX, Show } from "solid-js";
import { connection } from "../../realtime";
import { AgentsState, ConnState } from "../molecules";
import type { Halt } from "./halt";
import { breadcrumb, pageTitle } from "./nav";
import "./top-bar.css";

export function TopBar(props: {
  drawerOpen: boolean;
  onMenu: () => void;
  halt: Halt;
  onToggleHalt: () => void;
}): JSX.Element {
  return (
    <header class="topbar">
      <button
        type="button"
        class="menu-button"
        aria-label="Open navigation"
        aria-expanded={props.drawerOpen}
        onClick={() => props.onMenu()}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none">
          <path d="M2 4 H14 M2 8 H14 M2 12 H14" />
        </svg>
      </button>
      <h1 class="topbar-title">
        <Show when={breadcrumb()} fallback={pageTitle()}>
          {(crumb) => (
            <>
              <a href={crumb().parent.href}>{crumb().parent.label}</a> /{" "}
              <span class={crumb().plain ? undefined : "topbar-id"}>{crumb().id}</span>
            </>
          )}
        </Show>
      </h1>
      <Show when={props.halt.failure()}>
        {(message) => (
          <span class="halt-error" role="alert">
            {message()}
          </span>
        )}
      </Show>
      <span class="topbar-conn" data-live={connection() === "live"}>
        <ConnState state={connection()} />
      </span>
      <Show when={props.halt.halted() !== undefined}>
        <AgentsState halted={props.halt.halted() === true} admin onToggle={props.onToggleHalt} />
      </Show>
    </header>
  );
}
