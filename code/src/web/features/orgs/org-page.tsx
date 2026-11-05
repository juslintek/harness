import { useState } from "preact/hooks";
import type { OrgDetail } from "../../../shared/orgs";
import { api } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { ignored } from "../auth/me";
import { useAction } from "../auth/use-action";
import { BridgeSettings } from "../bridge/bridge-settings";
import { Members } from "./members";
import { isAdmin, OrgGate, useOrg } from "./org-data";
import { Positions } from "./positions";
import { Projects } from "./projects";

function Teams({
  detail,
  onChange,
}: {
  detail: OrgDetail;
  onChange: () => void;
}): preact.JSX.Element {
  const [name, setName] = useState("");
  const [teamId, setTeamId] = useState("");
  const [memberId, setMemberId] = useState("");
  const action = useAction();
  const call = (path: string, body: unknown, after: () => void): void => {
    action
      .run(async () => {
        await api(path, ignored, { method: "POST", body });
        after();
        onChange();
      })
      .catch((err: unknown) => console.error(err));
  };
  const admin = isAdmin(detail);
  return (
    <section>
      <h3>Teams</h3>
      <ul class="plain">
        {detail.teams.map((t) => (
          <li key={t.id} class="card">
            {t.name}
          </li>
        ))}
      </ul>
      {admin && (
        <>
          <form
            class="row"
            onSubmit={(e) => {
              e.preventDefault();
              call(`/api/orgs/${detail.org.slug}/teams`, { name }, () => setName(""));
            }}
          >
            <label>
              New team
              <input
                value={name}
                required
                maxLength={80}
                onInput={(e) => setName(e.currentTarget.value)}
              />
            </label>
            <button type="submit" disabled={action.busy}>
              Create team
            </button>
          </form>
          <form
            class="row"
            onSubmit={(e) => {
              e.preventDefault();
              call(
                `/api/orgs/${detail.org.slug}/teams/${teamId}/members`,
                { memberId },
                () => undefined,
              );
            }}
          >
            <label>
              Team
              <select value={teamId} required onChange={(e) => setTeamId(e.currentTarget.value)}>
                <option value="">Choose…</option>
                {detail.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Member
              <select
                value={memberId}
                required
                onChange={(e) => setMemberId(e.currentTarget.value)}
              >
                <option value="">Choose…</option>
                {detail.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    @{m.handle}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={action.busy}>
              Add to team
            </button>
          </form>
        </>
      )}
      <ErrorLine message={action.error} />
    </section>
  );
}

export function OrgPage({ slug }: { slug: string }): preact.JSX.Element {
  return <OrgGate slug={slug}>{() => <OrgSettings slug={slug} />}</OrgGate>;
}

function OrgSettings({ slug }: { slug: string }): preact.JSX.Element {
  const org = useOrg(slug);
  if (org.error) return <ErrorLine message={org.error} />;
  if (!org.data) return <p class="muted">Loading…</p>;
  const detail = org.data;
  return (
    <div class="org-settings">
      <h2>
        {detail.org.name} <span class="muted">{slug}</span>
      </h2>
      <Teams detail={detail} onChange={org.reload} />
      <Members detail={detail} onChange={org.reload} />
      <Positions detail={detail} onChange={org.reload} />
      <Projects detail={detail} onChange={org.reload} />
      {isAdmin(detail) && <BridgeSettings slug={slug} />}
    </div>
  );
}
