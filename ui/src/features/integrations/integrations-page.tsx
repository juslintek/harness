import { type JSX, Show } from "solid-js";
import { me } from "../../auth/me";
import { State } from "../../ui/primitives";
import { DesktopCard } from "./desktop-card";
import "./integrations.css";
import { SmtpCard } from "./smtp-card";
import { TunnelCard } from "./tunnel-card";

export function IntegrationsPage(): JSX.Element {
  return (
    <Show
      when={me()?.user.instanceAdmin === true}
      fallback={<State kind="empty" message="Not available." />}
    >
      <div class="integrations">
        <h1>Integrations</h1>
        <SmtpCard />
        <TunnelCard />
        <DesktopCard />
      </div>
    </Show>
  );
}
