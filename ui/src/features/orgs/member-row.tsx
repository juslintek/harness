import type { MemberView, OrgDetail } from "@shared/orgs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ignored } from "../../auth/me";
import { createAction } from "../../ui/action";
import { Button, StatusBadge } from "../../ui/atoms";
import { ConfirmButton, Dialog } from "../../ui/molecules";
import { ProfileEditor } from "./profile-editor";
import { FormError, isAdmin, ROLES } from "./shared";

export function MemberRow(props: {
  member: MemberView;
  detail: OrgDetail;
  onDone: (text: string) => void;
}): JSX.Element {
  const action = createAction();
  const [editing, setEditing] = createSignal(false);
  const base = (): string => `/api/orgs/${props.detail.org.slug}/members/${props.member.id}`;
  const call = (method: "PATCH" | "DELETE", done: string, body?: unknown): Promise<void> =>
    action.run(async () => {
      await api(base(), ignored, body === undefined ? { method } : { method, body });
      props.onDone(done);
    });
  const handle = (): string => props.member.handle;
  const first = (): string => props.member.displayName.split(" ")[0] ?? handle();
  const isMe = (): boolean => props.member.id === props.detail.me.id;
  const lastOwner = (): boolean =>
    props.member.role === "owner" &&
    props.detail.members.filter((m) => m.role === "owner").length === 1;
  // Only an owner may touch an owner (the server answers 403 otherwise).
  const canRemove = (): boolean =>
    !isMe() && !lastOwner() && (props.member.role !== "owner" || props.detail.me.role === "owner");
  return (
    <tr>
      <th scope="row">
        <span class="who">
          <span>
            @{handle()}
            <Show when={isMe()}>
              {" "}
              <span class="muted">· you</span>
            </Show>
          </span>
          <small>{props.member.displayName}</small>
        </span>
      </th>
      <td data-label="Kind">
        <StatusBadge tone="neutral" value={props.member.kind} />
      </td>
      <td data-label="Role">
        <Show
          when={isAdmin(props.detail) && !lastOwner()}
          fallback={<span>{props.member.role}</span>}
        >
          <select
            class="cell-select"
            aria-label={`Role of @${handle()}`}
            onChange={(e) => {
              const select = e.currentTarget;
              const role = select.value;
              // An uncontrolled select would keep a role the server refused.
              void call("PATCH", `@${handle()} is now ${role}.`, { role }).then(() => {
                if (action.error()) select.value = props.member.role;
              });
            }}
          >
            <For each={ROLES}>{(r) => <option selected={r === props.member.role}>{r}</option>}</For>
          </select>
        </Show>
      </td>
      <td data-label="State">
        <StatusBadge
          tone={props.member.paused ? "danger" : "success"}
          value={props.member.paused ? "paused" : "active"}
        />
      </td>
      <td class="actions-cell">
        <Show when={isAdmin(props.detail)}>
          <div class="row-actions">
            <Show when={props.member.kind === "agent"}>
              <Button
                size="sm"
                disabled={action.busy()}
                aria-label={`${props.member.paused ? "Resume" : "Pause"} @${handle()}`}
                onClick={() =>
                  void call(
                    "PATCH",
                    `@${handle()} is ${props.member.paused ? "running again" : "paused"}.`,
                    { paused: !props.member.paused },
                  )
                }
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
            <Show when={canRemove()}>
              <ConfirmButton
                size="sm"
                text="Remove"
                label={`Remove @${handle()}`}
                title={`Remove @${handle()} from ${props.detail.org.name}?`}
                message={`${props.member.displayName} loses access to ${props.detail.org.name} and their live views close. You can invite them again later.`}
                confirm={`Remove ${first()}`}
                onConfirm={() =>
                  void call("DELETE", `Removed @${handle()} from ${props.detail.org.name}.`)
                }
              />
            </Show>
            <Show when={isMe() || lastOwner()}>
              <span class="muted">
                {isMe() ? (lastOwner() ? "You are the only owner" : "You") : "The only owner"}
              </span>
            </Show>
          </div>
          <FormError message={action.error()} />
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
