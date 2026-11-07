import { useState } from "preact/hooks";
import { z } from "zod";
import { api } from "../../api";
import { PrefsGrid } from "../notify/prefs";
import { Targets } from "../notify/targets";
import { selectedSlug } from "../orgs/org-switcher";
import { ErrorLine } from "./error-line";
import { McpCard } from "./mcp-card";
import { me } from "./me";
import { PasskeysList } from "./passkeys-list";
import { RecoveryCodes } from "./recovery-codes";
import { SessionsList } from "./sessions-list";
import { useAction } from "./use-action";

const regeneratedSchema: z.ZodType<{ recoveryCodes: string[] }> = z.object({
  recoveryCodes: z.array(z.string()),
});

function Recovery(): preact.JSX.Element {
  const action = useAction();
  const [codes, setCodes] = useState<string[] | null>(null);
  const regenerate = (): Promise<void> =>
    action.run(async () => {
      const done = await api("/api/auth/recovery/regenerate", regeneratedSchema, {
        method: "POST",
        body: {},
      });
      setCodes(done.recoveryCodes);
    });
  return (
    <section aria-labelledby="recovery-h">
      <h3 id="recovery-h">Recovery codes</h3>
      <ErrorLine message={action.error} />
      {codes ? (
        <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
      ) : (
        <>
          <p class="muted">Generating new codes makes the old ones stop working.</p>
          <button type="button" disabled={action.busy} onClick={regenerate}>
            Regenerate recovery codes
          </button>
        </>
      )}
    </section>
  );
}

export function AccountPage(): preact.JSX.Element {
  const user = me.value?.user;
  const orgs = me.value?.orgs ?? [];
  const [orgSlug, setOrgSlug] = useState<string | null>(null);
  const org =
    orgs.find((item) => item.slug === orgSlug) ??
    orgs.find((item) => item.slug === selectedSlug()) ??
    orgs[0];
  return (
    <div class="auth-page">
      <h2>Account</h2>
      {user && (
        <p>
          {user.name} <span class="muted">{user.email}</span>
        </p>
      )}
      {org && (
        <>
          {orgs.length > 1 && (
            <label>
              Notification organization
              <select value={org.slug} onChange={(e) => setOrgSlug(e.currentTarget.value)}>
                {orgs.map((item) => (
                  <option key={item.id} value={item.slug}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <PrefsGrid key={org.slug} org={org.slug} />
          <Targets key={org.slug} org={org.slug} />
        </>
      )}
      <McpCard />
      <PasskeysList />
      <Recovery />
      <SessionsList />
    </div>
  );
}
