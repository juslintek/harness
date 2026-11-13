import { type JSX, Show } from "solid-js";
import { me } from "../../auth/me";
import { selectedSlug } from "../../orgs";
import { Help } from "../../ui/atoms";
import { Panel, State } from "../../ui/molecules";
import { DesktopCard } from "./desktop-card";
import "./integrations.css";
import { SmtpCard } from "./smtp-card";
import { TunnelCard } from "./tunnel-card";

export function IntegrationsPage(): JSX.Element {
  const slug = (): string | undefined => selectedSlug() ?? me()?.orgs[0]?.slug;
  return (
    <Show
      when={me()?.user.instanceAdmin === true}
      fallback={<State kind="empty" message="Not available." />}
    >
      <div class="integrations">
        <h1>Integrations</h1>
        <Help>
          Connections from this instance to other tools. Only instance admins see this page.
        </Help>
        <TunnelCard />
        <SmtpCard />
        <DesktopCard />
        <Panel title="Other connections">
          <ul class="int-plain int-other">
            <li>
              <span>
                <b>claude.ai and ChatGPT</b>
                <Help small>
                  Your own connector, added with a URL and approved with your passkey.
                </Help>
              </span>
              <a href="#/account">Account › Remote MCP</a>
            </li>
            <Show when={slug()}>
              {(org) => (
                <li>
                  <span>
                    <b>Slack and Telegram</b>
                    <Help small>
                      Mirror a Harness channel with a Slack channel or a Telegram chat.
                    </Help>
                  </span>
                  <a href={`#/o/${org()}/settings/bridges`}>Settings › Bridges</a>
                </li>
              )}
            </Show>
          </ul>
        </Panel>
      </div>
    </Show>
  );
}
