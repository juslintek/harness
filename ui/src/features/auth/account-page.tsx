import { createSignal, For, type JSX, Show } from "solid-js";
import { me } from "../../auth/me";
import { selectedSlug } from "../../orgs";
import { Field } from "../../ui/primitives";
import { PrefsGrid } from "../notify/prefs";
import { Targets } from "../notify/targets";
import "./account.css";
import { McpCard } from "./mcp-card";
import { PasskeysList } from "./passkeys";
import { Recovery } from "./recovery";
import { SessionsList } from "./sessions";

export function AccountPage(): JSX.Element {
  const [orgSlug, setOrgSlug] = createSignal<string | null>(null);
  const orgs = (): { id: string; slug: string; name: string }[] => me()?.orgs ?? [];
  const org = (): string | undefined =>
    (
      orgs().find((o) => o.slug === orgSlug()) ??
      orgs().find((o) => o.slug === selectedSlug()) ??
      orgs()[0]
    )?.slug;
  return (
    <div class="acct-page">
      <Show when={me()?.user}>
        {(user) => (
          <header class="acct-who">
            <h2>{user().name}</h2>
            <span class="acct-meta">{user().email}</span>
          </header>
        )}
      </Show>
      <Show when={orgs().length > 1}>
        <div class="acct-org">
          <Field label="Notification organization">
            {(control) => (
              <select
                {...control()}
                value={org()}
                onChange={(e) => setOrgSlug(e.currentTarget.value)}
              >
                <For each={orgs()}>{(item) => <option value={item.slug}>{item.name}</option>}</For>
              </select>
            )}
          </Field>
        </div>
      </Show>
      <div class="acct-cols">
        <div class="acct-col">
          <Show when={org()} keyed>
            {(slug) => (
              <>
                <PrefsGrid org={slug} />
                <Targets org={slug} />
              </>
            )}
          </Show>
        </div>
        <div class="acct-col">
          <McpCard />
          <PasskeysList />
          <Recovery />
          <SessionsList />
        </div>
      </div>
    </div>
  );
}
