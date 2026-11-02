import { useState } from "preact/hooks";
import type { OrgDetail, PositionView } from "../../../shared/orgs";
import { api } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { ignored } from "../auth/me";
import { useAction } from "../auth/use-action";
import { isAdmin } from "./org-data";

function Node({
  position,
  all,
  detail,
  depth,
}: {
  position: PositionView;
  all: PositionView[];
  detail: OrgDetail;
  depth: number;
}): preact.JSX.Element {
  const holder = detail.members.find((m) => m.id === position.memberId);
  const team = detail.teams.find((t) => t.id === position.teamId);
  // depth is capped so a reporting loop cannot recurse forever.
  const reports = depth < 12 ? all.filter((p) => p.reportsTo === position.id) : [];
  return (
    <li>
      <span class="card position">
        <strong>{position.title}</strong>{" "}
        {holder ? `@${holder.handle}` : <span class="muted">vacant</span>}
        {position.isManager && <span class="badge">manager</span>}
        {team && <span class="muted"> {team.name}</span>}
      </span>
      {reports.length > 0 && (
        <ul class="org-chart">
          {reports.map((p) => (
            <Node key={p.id} position={p} all={all} detail={detail} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function NewPosition({
  detail,
  onChange,
}: {
  detail: OrgDetail;
  onChange: () => void;
}): preact.JSX.Element {
  const [title, setTitle] = useState("");
  const [memberId, setMemberId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [reportsTo, setReportsTo] = useState("");
  const [isManager, setIsManager] = useState(false);
  const action = useAction();
  const submit = (e: Event): void => {
    e.preventDefault();
    const body = {
      title,
      isManager,
      ...(memberId && { memberId }),
      ...(teamId && { teamId }),
      ...(reportsTo && { reportsTo }),
    };
    action
      .run(async () => {
        await api(`/api/orgs/${detail.org.slug}/positions`, ignored, { method: "POST", body });
        setTitle("");
        onChange();
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <form class="row" onSubmit={submit}>
      <label>
        Title
        <input
          value={title}
          required
          maxLength={80}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
      </label>
      <label>
        Holder
        <select value={memberId} onChange={(e) => setMemberId(e.currentTarget.value)}>
          <option value="">Vacant</option>
          {detail.members.map((m) => (
            <option key={m.id} value={m.id}>
              @{m.handle}
            </option>
          ))}
        </select>
      </label>
      <label>
        Reports to
        <select value={reportsTo} onChange={(e) => setReportsTo(e.currentTarget.value)}>
          <option value="">Nobody</option>
          {detail.positions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        Team
        <select value={teamId} onChange={(e) => setTeamId(e.currentTarget.value)}>
          <option value="">None</option>
          {detail.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label class="inline">
        <input
          type="checkbox"
          checked={isManager}
          onChange={(e) => setIsManager(e.currentTarget.checked)}
        />
        Manager
      </label>
      <button type="submit" disabled={action.busy}>
        Add position
      </button>
      <ErrorLine message={action.error} />
    </form>
  );
}

export function Positions({
  detail,
  onChange,
}: {
  detail: OrgDetail;
  onChange: () => void;
}): preact.JSX.Element {
  const ids = new Set(detail.positions.map((p) => p.id));
  const roots = detail.positions.filter((p) => p.reportsTo === null || !ids.has(p.reportsTo));
  return (
    <section>
      <h3>Positions</h3>
      {roots.length === 0 && <p class="muted">No positions yet.</p>}
      <ul class="org-chart root">
        {roots.map((p) => (
          <Node key={p.id} position={p} all={detail.positions} detail={detail} depth={0} />
        ))}
      </ul>
      {isAdmin(detail) && <NewPosition detail={detail} onChange={onChange} />}
    </section>
  );
}
