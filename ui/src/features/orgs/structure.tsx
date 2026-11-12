import type { OrgDetail, PositionView, ProjectView } from "@shared/orgs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ignored } from "../../auth/me";
import { createAction } from "../../ui/action";
import { TableBox } from "../../ui/data-table";
import { Button, Dialog, Field, Panel, StatusBadge } from "../../ui/primitives";
import { FormError, isAdmin } from "./shared";

function Node(props: {
  position: PositionView;
  all: PositionView[];
  detail: OrgDetail;
  depth: number;
}): JSX.Element {
  const holder = () => props.detail.members.find((m) => m.id === props.position.memberId);
  const team = () => props.detail.teams.find((t) => t.id === props.position.teamId);
  // depth is capped so a reporting loop cannot recurse forever.
  const reports = (): PositionView[] =>
    props.depth < 12 ? props.all.filter((p) => p.reportsTo === props.position.id) : [];
  return (
    <li>
      <span class="position">
        <strong>{props.position.title}</strong>
        <Show when={holder()} fallback={<span class="muted">vacant</span>}>
          {(m) => <span>@{m().handle}</span>}
        </Show>
        <Show when={props.position.isManager}>
          <StatusBadge tone="info" value="manager" />
        </Show>
        <Show when={team()}>{(t) => <span class="muted">{t().name}</span>}</Show>
      </span>
      <Show when={reports().length > 0}>
        <ul class="org-chart">
          <For each={reports()}>
            {(p) => (
              <Node position={p} all={props.all} detail={props.detail} depth={props.depth + 1} />
            )}
          </For>
        </ul>
      </Show>
    </li>
  );
}

function NewPosition(props: { detail: OrgDetail; onChange: () => void }): JSX.Element {
  const [title, setTitle] = createSignal("");
  const [memberId, setMemberId] = createSignal("");
  const [teamId, setTeamId] = createSignal("");
  const [reportsTo, setReportsTo] = createSignal("");
  const [isManager, setIsManager] = createSignal(false);
  const action = createAction();
  return (
    <form
      class="form-row"
      onSubmit={(e) => {
        e.preventDefault();
        const body = {
          title: title(),
          isManager: isManager(),
          ...(memberId() && { memberId: memberId() }),
          ...(teamId() && { teamId: teamId() }),
          ...(reportsTo() && { reportsTo: reportsTo() }),
        };
        void action.run(async () => {
          await api(`/api/orgs/${props.detail.org.slug}/positions`, ignored, {
            method: "POST",
            body,
          });
          setTitle("");
          props.onChange();
        });
      }}
    >
      <Field label="Title" error={action.error()}>
        {(c) => (
          <input
            {...c()}
            value={title()}
            required
            maxLength={80}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />
        )}
      </Field>
      <Field label="Holder">
        {(c) => (
          <select {...c()} onChange={(e) => setMemberId(e.currentTarget.value)}>
            <option value="">Vacant</option>
            <For each={props.detail.members}>
              {(m) => <option value={m.id}>@{m.handle}</option>}
            </For>
          </select>
        )}
      </Field>
      <Field label="Reports to">
        {(c) => (
          <select {...c()} onChange={(e) => setReportsTo(e.currentTarget.value)}>
            <option value="">Nobody</option>
            <For each={props.detail.positions}>
              {(p) => <option value={p.id}>{p.title}</option>}
            </For>
          </select>
        )}
      </Field>
      <Field label="Team">
        {(c) => (
          <select {...c()} onChange={(e) => setTeamId(e.currentTarget.value)}>
            <option value="">None</option>
            <For each={props.detail.teams}>{(t) => <option value={t.id}>{t.name}</option>}</For>
          </select>
        )}
      </Field>
      <label class="check">
        <input
          type="checkbox"
          checked={isManager()}
          onChange={(e) => setIsManager(e.currentTarget.checked)}
        />
        Manager
      </label>
      <Button type="submit" disabled={action.busy()}>
        Add position
      </Button>
    </form>
  );
}

export function Positions(props: { detail: OrgDetail; onChange: () => void }): JSX.Element {
  const roots = (): PositionView[] => {
    const ids = new Set(props.detail.positions.map((p) => p.id));
    return props.detail.positions.filter((p) => p.reportsTo === null || !ids.has(p.reportsTo));
  };
  return (
    <Panel title="Positions">
      <div class="stack">
        <Show when={roots().length > 0} fallback={<p class="muted">No positions yet.</p>}>
          <ul class="org-chart">
            <For each={roots()}>
              {(p) => (
                <Node position={p} all={props.detail.positions} detail={props.detail} depth={0} />
              )}
            </For>
          </ul>
        </Show>
        <Show when={isAdmin(props.detail)}>
          <NewPosition detail={props.detail} onChange={props.onChange} />
        </Show>
      </div>
    </Panel>
  );
}

function Grants(props: { project: ProjectView; onChange: () => void }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [orgId, setOrgId] = createSignal("");
  const [permission, setPermission] = createSignal("read");
  const action = createAction();
  const call = (method: "POST" | "DELETE"): void => {
    const body =
      method === "POST" ? { orgId: orgId(), permission: permission() } : { orgId: orgId() };
    void action.run(async () => {
      await api(`/api/projects/${props.project.id}/grants`, ignored, { method, body });
      setOrgId("");
      props.onChange();
    });
  };
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Grants
      </Button>
      <Dialog
        open={open()}
        onClose={() => setOpen(false)}
        title={`Grants for ${props.project.key}`}
        footer={<Button onClick={() => setOpen(false)}>Close</Button>}
      >
        <div class="stack">
          <div class="form-row">
            <Field label="Other org id">
              {(c) => (
                <input {...c()} value={orgId()} onInput={(e) => setOrgId(e.currentTarget.value)} />
              )}
            </Field>
            <Field label="Permission">
              {(c) => (
                <select {...c()} onChange={(e) => setPermission(e.currentTarget.value)}>
                  <option value="read">read</option>
                  <option value="write">write</option>
                </select>
              )}
            </Field>
          </div>
          <div class="row-actions">
            <Button disabled={action.busy() || orgId() === ""} onClick={() => call("POST")}>
              Grant
            </Button>
            <Button
              tone="danger"
              disabled={action.busy() || orgId() === ""}
              onClick={() => call("DELETE")}
            >
              Revoke
            </Button>
          </div>
          <FormError message={action.error()} />
        </div>
      </Dialog>
    </>
  );
}

function NewProject(props: { detail: OrgDetail; onChange: () => void }): JSX.Element {
  const [key, setKey] = createSignal("");
  const [name, setName] = createSignal("");
  const [repo, setRepo] = createSignal("");
  const action = createAction();
  return (
    <form
      class="form-row"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          const body = { key: key(), name: name(), ...(repo() && { repo: repo() }) };
          await api(`/api/orgs/${props.detail.org.slug}/projects`, ignored, {
            method: "POST",
            body,
          });
          setKey("");
          setName("");
          setRepo("");
          props.onChange();
        });
      }}
    >
      <Field label="Key" error={action.error()}>
        {(c) => (
          <input
            {...c()}
            value={key()}
            required
            maxLength={16}
            pattern="[A-Za-z0-9_\-]+"
            onInput={(e) => setKey(e.currentTarget.value)}
          />
        )}
      </Field>
      <Field label="Name">
        {(c) => (
          <input
            {...c()}
            value={name()}
            required
            maxLength={80}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        )}
      </Field>
      <Field label="Repo path (instance admin only)">
        {(c) => <input {...c()} value={repo()} onInput={(e) => setRepo(e.currentTarget.value)} />}
      </Field>
      <Button type="submit" disabled={action.busy()}>
        Create project
      </Button>
    </form>
  );
}

export function Projects(props: { detail: OrgDetail; onChange: () => void }): JSX.Element {
  return (
    <Panel title="Projects">
      <div class="stack">
        <TableBox label="Projects">
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Repo</th>
              <th scope="col">Sharing</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.detail.projects}>
              {(p) => (
                <tr>
                  <th scope="row">
                    <a href={`#/o/${props.detail.org.slug}/board/${p.id}`}>
                      <span class="mono">{p.key}</span> {p.name}
                    </a>
                  </th>
                  <td class="mono">{p.repo ?? "no repo"}</td>
                  <td>
                    <Show when={p.orgId !== props.detail.org.id}>
                      <StatusBadge tone="neutral" value="shared with this org" />
                    </Show>
                    <Show when={isAdmin(props.detail) && p.orgId === props.detail.org.id}>
                      <Grants project={p} onChange={props.onChange} />
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </TableBox>
        <Show when={isAdmin(props.detail)}>
          <NewProject detail={props.detail} onChange={props.onChange} />
        </Show>
      </div>
    </Panel>
  );
}
