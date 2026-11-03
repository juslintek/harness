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
  const task = tasks.data?.find((t) => t.number === Number(number));
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

export function ScopePicker({
  detail,
  onScope,
}: {
  detail: OrgDetail;
  onScope: (scope: Scope | null) => void;
}): preact.JSX.Element {
  const [layer, setLayer] = useState<ScopeLayer>("org");
  const [teamId, setTeamId] = useState(detail.teams[0]?.id ?? "");
  const [memberId, setMemberId] = useState(detail.members[0]?.id ?? "");
  const [projectId, setProjectId] = useState(detail.projects[0]?.id ?? "");
  const [number, setNumber] = useState("");
  const { scope, note } = useScopeTarget(detail, { layer, teamId, memberId, projectId, number });
  useEffect(() => onScope(scope), [scope?.layer, scope?.targetId]);
  return (
    <div class="row scope-picker">
      <label>
        Scope
        <select value={layer} onChange={(e) => setLayer(e.currentTarget.value as ScopeLayer)}>
          <option value="org">Whole org</option>
          <option value="team">Team</option>
          <option value="agent">Member</option>
          <option value="task">Task</option>
        </select>
      </label>
      {layer === "team" && (
        <label>
          Team
          <select value={teamId} onChange={(e) => setTeamId(e.currentTarget.value)}>
            <Options items={detail.teams.map((t) => ({ id: t.id, label: t.name }))} />
          </select>
        </label>
      )}
      {layer === "agent" && (
        <label>
          Member
          <select value={memberId} onChange={(e) => setMemberId(e.currentTarget.value)}>
            <Options items={detail.members.map((m) => ({ id: m.id, label: m.handle }))} />
          </select>
        </label>
      )}
      {layer === "task" && (
        <>
          <label>
            Project
            <select value={projectId} onChange={(e) => setProjectId(e.currentTarget.value)}>
              <Options items={detail.projects.map((p) => ({ id: p.id, label: p.key }))} />
            </select>
          </label>
          <label>
            Task number
            <input
              type="number"
              min="1"
              value={number}
              onInput={(e) => setNumber(e.currentTarget.value)}
            />
          </label>
        </>
      )}
      {note && <p class="muted scope-note">{note}</p>}
    </div>
  );
}
