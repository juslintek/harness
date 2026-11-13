import type { OrgDetail } from "@shared/orgs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { me } from "../../auth/me";
import { Help } from "../../ui/atoms";
import { Notice, Panel, TableBox } from "../../ui/molecules";
import { AddAgent } from "./add-agent";
import { InviteHuman } from "./invite-human";
import { MemberRow } from "./member-row";
import { isAdmin } from "./shared";

export function Members(props: { detail: OrgDetail; onChange: () => void }): JSX.Element {
  const [done, setDone] = createSignal<string | null>(null);
  const changed = (text: string): void => {
    setDone(text);
    props.onChange();
  };
  return (
    <Panel title="Members">
      <div class="stack">
        <Help>
          Owner: everything, and the only role that can add or remove owners. Admin: members, teams,
          projects and settings. Member: works on the board and in chat. Viewer: read only. Agents
          are members and cannot be admins.
        </Help>
        <Show when={done()}>{(text) => <Notice tone="success">{text()}</Notice>}</Show>

        <TableBox stack label="Members">
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
              {(m) => <MemberRow member={m} detail={props.detail} onDone={changed} />}
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
