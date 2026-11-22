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
            <li>
              <span>
                <b>Federation</b>
                <Help small>
                  Pair with other Harness instances and share projects without syncing secrets.
                </Help>
              </span>
              <a href="#/federation">Manage federation</a>
            </li>
            <li>
              <span>
                <b>Deploy</b>
                <Help small>
                  Deploy a signed Harness binary to SSH or Tailscale targets with human approval.
                </Help>
              </span>
              <a href="#/deploy">Manage deploy</a>
            </li>
            <li>
              <span>
                <b>Updates</b>
                <Help small>
                  Update this instance from a branch with scratch verification and rollback.
                </Help>
              </span>
              <a href="#/updates">Manage updates</a>
            </li>
          </ul>
        </Panel>
      </div>
    </Show>
  );
}
