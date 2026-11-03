import { useEffect, useState } from "preact/hooks";
import { z } from "zod";
import { taskViewSchema } from "../../../shared/board";
import type { OrgDetail } from "../../../shared/orgs";
import { api, useLoad } from "../../api";
import type { ScopeLayer } from "./policies-data";

export interface Scope {
  layer: ScopeLayer;
  targetId: string;
  query: string;
}

interface Pick {
  layer: ScopeLayer;
  teamId: string;
  memberId: string;
  projectId: string;
  number: string;
}

const taskList = z.array(taskViewSchema);

function useScopeTarget(detail: OrgDetail, pick: Pick): { scope: Scope | null; note: string } {
  const { layer, teamId, memberId, projectId, number } = pick;
  const tasks = useLoad(
    () =>
      layer === "task" && projectId
        ? api(`/api/projects/${projectId}/tasks`, taskList)
        : Promise.resolve([]),
    [layer, projectId],
  );
  if (layer === "org") return { scope: { layer, targetId: detail.org.id, query: "" }, note: "" };
  if (layer === "team") {
    const query = `?team=${teamId}`;
    return { scope: teamId ? { layer, targetId: teamId, query } : null, note: "" };
  }
  if (layer === "agent") {
    const query = `?member=${memberId}`;
    return { scope: memberId ? { layer, targetId: memberId, query } : null, note: "" };
  }
  if (!number) return { scope: null, note: "" };
  const task = tasks.data?.find((t) => t.projectId === projectId && t.number === Number(number));
  if (!task) {
    return { scope: null, note: tasks.data ? "No task with that number." : "Looking up..." };
  }
  return { scope: { layer, targetId: task.id, query: `?task=${task.id}` }, note: task.title };
}

function Options({ items }: { items: { id: string; label: string }[] }): preact.JSX.Element {
  return (
    <>
      {items.map((i) => (
        <option key={i.id} value={i.id}>
          {i.label}
        </option>
      ))}
    </>
  );
}

function TaskPick({
  detail,
  pick,
  onPick,
}: {
  detail: OrgDetail;
  pick: Pick;
  onPick: (patch: Partial<Pick>) => void;
}): preact.JSX.Element {
  return (
    <>
      <label>
        Project
        <select
          value={pick.projectId}
          onChange={(e) => onPick({ projectId: e.currentTarget.value })}
        >
          <Options items={detail.projects.map((p) => ({ id: p.id, label: p.key }))} />
        </select>
      </label>
      <label>
        Task number
        <input
          type="number"
          min="1"
          value={pick.number}
          onInput={(e) => onPick({ number: e.currentTarget.value })}
        />
      </label>
    </>
  );
}

function TargetPick({
  detail,
  pick,
  onPick,
}: {
  detail: OrgDetail;
  pick: Pick;
  onPick: (patch: Partial<Pick>) => void;
}): preact.JSX.Element | null {
  if (pick.layer === "team") {
    return (
      <label>
        Team
        <select value={pick.teamId} onChange={(e) => onPick({ teamId: e.currentTarget.value })}>
          <Options items={detail.teams.map((t) => ({ id: t.id, label: t.name }))} />
        </select>
      </label>
    );
  }
  if (pick.layer === "agent") {
    return (
      <label>
        Member
        <select value={pick.memberId} onChange={(e) => onPick({ memberId: e.currentTarget.value })}>
          <Options items={detail.members.map((m) => ({ id: m.id, label: m.handle }))} />
        </select>
      </label>
    );
  }
  if (pick.layer === "org") return null;
  return <TaskPick detail={detail} pick={pick} onPick={onPick} />;
}

export function ScopePicker({
  detail,
  onScope,
}: {
  detail: OrgDetail;
  onScope: (scope: Scope | null) => void;
}): preact.JSX.Element {
  const [pick, setPick] = useState<Pick>({
    layer: "org",
    teamId: detail.teams[0]?.id ?? "",
    memberId: detail.members[0]?.id ?? "",
    projectId: detail.projects[0]?.id ?? "",
    number: "",
  });
  const { scope, note } = useScopeTarget(detail, pick);
  useEffect(() => onScope(scope), [scope?.layer, scope?.targetId]);
  return (
    <div class="row scope-picker">
      <label>
        Scope
        <select
          value={pick.layer}
          onChange={(e) => setPick({ ...pick, layer: e.currentTarget.value as ScopeLayer })}
        >
          <option value="org">Whole org</option>
          <option value="team">Team</option>
          <option value="agent">Member</option>
          <option value="task">Task</option>
        </select>
      </label>
      <TargetPick detail={detail} pick={pick} onPick={(patch) => setPick({ ...pick, ...patch })} />
      {note && <p class="muted scope-note">{note}</p>}
    </div>
  );
}
