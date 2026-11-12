import { taskViewSchema } from "@shared/board";
import type { OrgDetail } from "@shared/orgs";
import { createEffect, createMemo, createSignal, For, type JSX, Match, Switch } from "solid-js";
import { z } from "zod";
import { createLoad } from "../../load";
import { Field } from "../../ui/primitives";
import type { ScopeLayer } from "./policies-data";

export interface Scope {
  layer: ScopeLayer;
  targetId: string;
  query: string;
}

const taskList = z.array(taskViewSchema);

// Owns the task lookup so the tasks are fetched only while the Task scope is chosen.
function TaskPick(props: {
  detail: OrgDetail;
  onScope: (scope: Scope | null) => void;
}): JSX.Element {
  const [projectId, setProjectId] = createSignal(props.detail.projects[0]?.id ?? "");
  const [number, setNumber] = createSignal("");
  const tasks = createLoad(() => `/api/projects/${projectId()}/tasks`, taskList);
  const task = createMemo(() =>
    number() === ""
      ? undefined
      : tasks.data()?.find((t) => t.projectId === projectId() && t.number === Number(number())),
  );
  createEffect(() => {
    const t = task();
    props.onScope(t ? { layer: "task", targetId: t.id, query: `?task=${t.id}` } : null);
  });
  const note = (): string => {
    if (!projectId()) return "This org has no projects yet.";
    if (number() === "") return "";
    if (task()) return task()?.title ?? "";
    return tasks.data() ? "No task with that number." : "Looking up...";
  };
  return (
    <>
      <Field label="Project">
        {(c) => (
          <select {...c()} onChange={(e) => setProjectId(e.currentTarget.value)}>
            <For each={props.detail.projects}>
              {(p) => (
                <option value={p.id} selected={p.id === projectId()}>
                  {p.key}
                </option>
              )}
            </For>
          </select>
        )}
      </Field>
      <Field label="Task number">
        {(c) => (
          <input
            {...c()}
            type="number"
            min="1"
            value={number()}
            onInput={(e) => setNumber(e.currentTarget.value)}
          />
        )}
      </Field>
      <p class="muted-line">{note()}</p>
    </>
  );
}

export function ScopePicker(props: {
  detail: OrgDetail;
  onScope: (scope: Scope | null) => void;
}): JSX.Element {
  const [layer, setLayer] = createSignal<ScopeLayer>("org");
  const [teamId, setTeamId] = createSignal(props.detail.teams[0]?.id ?? "");
  const [memberId, setMemberId] = createSignal(props.detail.members[0]?.id ?? "");
  createEffect(() => {
    const l = layer();
    if (l === "org") props.onScope({ layer: l, targetId: props.detail.org.id, query: "" });
    else if (l === "team")
      props.onScope(teamId() ? { layer: l, targetId: teamId(), query: `?team=${teamId()}` } : null);
    else if (l === "agent")
      props.onScope(
        memberId() ? { layer: l, targetId: memberId(), query: `?member=${memberId()}` } : null,
      );
  });
  return (
    <div class="form-row">
      <Field label="Scope">
        {(c) => (
          <select {...c()} onChange={(e) => setLayer(e.currentTarget.value as ScopeLayer)}>
            <option value="org" selected={layer() === "org"}>
              Whole org
            </option>
            <option value="team" selected={layer() === "team"}>
              Team
            </option>
            <option value="agent" selected={layer() === "agent"}>
              Member
            </option>
            <option value="task" selected={layer() === "task"}>
              Task
            </option>
          </select>
        )}
      </Field>
      <Switch>
        <Match when={layer() === "team"}>
          <Field label="Team">
            {(c) => (
              <select {...c()} onChange={(e) => setTeamId(e.currentTarget.value)}>
                <For each={props.detail.teams}>
                  {(t) => (
                    <option value={t.id} selected={t.id === teamId()}>
                      {t.name}
                    </option>
                  )}
                </For>
              </select>
            )}
          </Field>
        </Match>
        <Match when={layer() === "agent"}>
          <Field label="Member">
            {(c) => (
              <select {...c()} onChange={(e) => setMemberId(e.currentTarget.value)}>
                <For each={props.detail.members}>
                  {(m) => (
                    <option value={m.id} selected={m.id === memberId()}>
                      {m.handle}
                    </option>
                  )}
                </For>
              </select>
            )}
          </Field>
        </Match>
        <Match when={layer() === "task"}>
          <TaskPick detail={props.detail} onScope={props.onScope} />
        </Match>
      </Switch>
    </div>
  );
}
