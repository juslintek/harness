import { inviteResultSchema, type MemberView, type OrgDetail, type Role } from "@shared/orgs";
import { agentRowSchema } from "@shared/runs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { ignored, me } from "../../auth/me";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { CopyButton } from "../../ui/copy-button";
import { TableBox } from "../../ui/data-table";
import { Button, Dialog, Field, Panel, StatusBadge } from "../../ui/primitives";
import { ProfileEditor } from "./profile-editor";
import { FormError, isAdmin } from "./shared";

const ROLES: Role[] = ["owner", "admin", "member", "viewer"];
const SPECIALTIES = ["frontend", "backend", "database", "devops", "security", "writing", "mobile"];

function MemberRow(props: {
  member: MemberView;
  detail: OrgDetail;
  onChange: () => void;
}): JSX.Element {
  const action = createAction();
  const [editing, setEditing] = createSignal(false);
  const [removing, setRemoving] = createSignal(false);
  const base = (): string => `/api/orgs/${props.detail.org.slug}/members/${props.member.id}`;
  const call = (method: "PATCH" | "DELETE", body?: unknown): Promise<void> =>
    action.run(async () => {
      await api(base(), ignored, body === undefined ? { method } : { method, body });
      props.onChange();
    });
  const handle = (): string => props.member.handle;
  return (
    <tr>
      <th scope="row">
        <span class="who">
          @{handle()}
          <small>{props.member.displayName}</small>
        </span>
      </th>
      <td>
        <StatusBadge tone="neutral" value={props.member.kind} />
      </td>
      <td>
        <Show
          when={isAdmin(props.detail)}
          fallback={<StatusBadge tone="neutral" value={props.member.role} />}
        >
          <select
            class="cell-select"
            aria-label={`Role of @${handle()}`}
            onChange={(e) => {
              const select = e.currentTarget;
              // An uncontrolled select would keep a role the server refused.
              void call("PATCH", { role: select.value }).then(() => {
                if (action.error()) select.value = props.member.role;
              });
            }}
          >
            <For each={ROLES}>{(r) => <option selected={r === props.member.role}>{r}</option>}</For>
          </select>
        </Show>
      </td>
      <td>
        <Show when={props.member.paused}>
          <StatusBadge tone="danger" value="paused" />
        </Show>
      </td>
      <td>
        <Show when={isAdmin(props.detail)}>
          <div class="row-actions">
            <Show when={props.member.kind === "agent"}>
              <Button
                size="sm"
                disabled={action.busy()}
                aria-label={`${props.member.paused ? "Resume" : "Pause"} @${handle()}`}
                onClick={() => void call("PATCH", { paused: !props.member.paused })}
              >
                {props.member.paused ? "Resume" : "Pause"}
              </Button>
              <Button
                size="sm"
                aria-label={`Profile of @${handle()}`}
                onClick={() => setEditing(true)}
              >
                Profile
              </Button>
            </Show>
            <Button
              size="sm"
              tone="danger"
              aria-label={`Remove @${handle()}`}
              onClick={() => setRemoving(true)}
            >
              Remove
            </Button>
          </div>
          <FormError message={action.error()} />
          <ConfirmDialog
            open={removing()}
            title={`Remove @${handle()}?`}
            message={`${props.member.displayName} loses access to ${props.detail.org.name}.`}
            confirm="Remove member"
            onClose={() => setRemoving(false)}
            onConfirm={() => {
              setRemoving(false);
              void call("DELETE");
            }}
          />
          <Show when={props.member.kind === "agent"}>
            <Dialog
              open={editing()}
              onClose={() => setEditing(false)}
              title={`Profile of @${handle()}`}
              class="dialog wide"
              footer={<Button onClick={() => setEditing(false)}>Close</Button>}
            >
              <Show when={editing()}>
                <ProfileEditor slug={props.detail.org.slug} member={props.member} />
              </Show>
            </Dialog>
          </Show>
        </Show>
      </td>
    </tr>
  );
}

function InviteHuman(props: { detail: OrgDetail; onChange: () => void }): JSX.Element {
  const [email, setEmail] = createSignal("");
  const [role, setRole] = createSignal<Role>("member");
  const [link, setLink] = createSignal<string | null>(null);
  const action = createAction();
  return (
    <>
      <form
        class="form-row"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const res = await api(
              `/api/orgs/${props.detail.org.slug}/members/humans`,
              inviteResultSchema,
              { method: "POST", body: { email: email(), role: role() } },
            );
            setLink(res.enrollmentLink);
            setEmail("");
            props.onChange();
          });
        }}
      >
        <Field label="Invite by email" error={action.error()}>
          {(c) => (
            <input
              {...c()}
              type="email"
              value={email()}
              required
              onInput={(e) => setEmail(e.currentTarget.value)}
            />
          )}
        </Field>
        <Field label="Role">
          {(c) => (
            <select {...c()} onChange={(e) => setRole(e.currentTarget.value as Role)}>
              <For each={ROLES}>{(r) => <option selected={r === role()}>{r}</option>}</For>
            </select>
          )}
        </Field>
        <Button type="submit" tone="primary" disabled={action.busy()}>
          Invite
        </Button>
      </form>
      <Show when={link()}>
        {(url) => (
          <div class="notice" role="status">
            <span>Send this enrollment link to the new member (valid 24 hours):</span>
            <code>{url()}</code>
            <div>
              <CopyButton text={url()} label="Copy the enrollment link" />
            </div>
          </div>
        )}
      </Show>
    </>
  );
}

function AddAgent(props: { detail: OrgDetail; onChange: () => void }): JSX.Element {
  const [agentId, setAgentId] = createSignal("");
  const [handle, setHandle] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");
  const [model, setModel] = createSignal("");
  const [heartbeat, setHeartbeat] = createSignal("");
  const [specialties, setSpecialties] = createSignal<string[]>([]);
  const action = createAction();
  // The runtime list is instance-admin only; without it the field is still a plain text input.
  const agents = createLoad("/api/agents", z.array(agentRowSchema));
  const usable = (): { id: string; name: string }[] =>
    agents.data()?.filter((a) => a.installed && a.enabled) ?? [];
  const toggle = (s: string, on: boolean): void => {
    setSpecialties((cur) => (on ? [...cur, s] : cur.filter((x) => x !== s)));
  };
  return (
    <form
      class="stack"
      onSubmit={(e) => {
        e.preventDefault();
        const body = {
          agentId: agentId(),
          handle: handle(),
          displayName: displayName() || handle(),
          specialties: specialties(),
          ...(model() && { model: model() }),
          ...(heartbeat() && { heartbeatMinutes: Number(heartbeat()) }),
        };
        void action.run(async () => {
          await api(`/api/orgs/${props.detail.org.slug}/members/agents`, ignored, {
            method: "POST",
            body,
          });
          setHandle("");
          setDisplayName("");
          props.onChange();
        });
      }}
    >
      <h3 class="sub-title">Add agent</h3>
      <div class="form-row">
        <Field label="Runtime">
          {(c) => (
            <>
              <input
                {...c()}
                value={agentId()}
                required
                list="runtime-ids"
                placeholder="runtime id, e.g. claude"
                onInput={(e) => setAgentId(e.currentTarget.value)}
              />
              <datalist id="runtime-ids">
                <For each={usable()}>{(a) => <option value={a.id}>{a.name}</option>}</For>
              </datalist>
            </>
          )}
        </Field>
        <Field label="Model">
          {(c) => (
            <input {...c()} value={model()} onInput={(e) => setModel(e.currentTarget.value)} />
          )}
        </Field>
        <Field label="Handle">
          {(c) => (
            <input
              {...c()}
              value={handle()}
              required
              pattern="[a-z0-9][a-z0-9_\-]{1,31}"
              onInput={(e) => setHandle(e.currentTarget.value)}
            />
          )}
        </Field>
        <Field label="Display name">
          {(c) => (
            <input
              {...c()}
              value={displayName()}
              onInput={(e) => setDisplayName(e.currentTarget.value)}
            />
          )}
        </Field>
        <Field label="Heartbeat (minutes)">
          {(c) => (
            <input
              {...c()}
              type="number"
              min={1}
              value={heartbeat()}
              onInput={(e) => setHeartbeat(e.currentTarget.value)}
            />
          )}
        </Field>
      </div>
      <fieldset class="checks">
        <legend class="sub-title">Specialties</legend>
        <For each={SPECIALTIES}>
          {(s) => (
            <label class="check">
              <input
                type="checkbox"
                checked={specialties().includes(s)}
                onChange={(e) => toggle(s, e.currentTarget.checked)}
              />
              {s}
            </label>
          )}
        </For>
      </fieldset>
      <div>
        <Button type="submit" disabled={action.busy()}>
          Add agent
        </Button>
      </div>
      <FormError message={action.error()} />
    </form>
  );
}

export function Members(props: { detail: OrgDetail; onChange: () => void }): JSX.Element {
  return (
    <Panel title="Members">
      <div class="stack">
        <TableBox label="Members">
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col">Kind</th>
              <th scope="col">Role</th>
              <th scope="col">State</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.detail.members}>
              {(m) => <MemberRow member={m} detail={props.detail} onChange={props.onChange} />}
            </For>
          </tbody>
        </TableBox>
        <Show when={isAdmin(props.detail)}>
          <InviteHuman detail={props.detail} onChange={props.onChange} />
          <Show when={me()?.user.instanceAdmin === true}>
            <AddAgent detail={props.detail} onChange={props.onChange} />
          </Show>
        </Show>
      </div>
    </Panel>
  );
}
