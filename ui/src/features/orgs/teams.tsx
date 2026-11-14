import type { OrgDetail } from "@shared/orgs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ignored } from "../../auth/me";
import { createAction } from "../../ui/action";
import { Button } from "../../ui/atoms";
import { Field, Panel } from "../../ui/molecules";
import { isAdmin } from "./shared";

export function Teams(props: { detail: OrgDetail; onChange: () => void }): JSX.Element {
  const [name, setName] = createSignal("");
  const [teamId, setTeamId] = createSignal("");
  const [memberId, setMemberId] = createSignal("");
  const create = createAction();
  const join = createAction();
  const slug = (): string => props.detail.org.slug;
  return (
    <Panel title="Teams">
      <div class="stack">
        <Show when={props.detail.teams.length > 0} fallback={<p class="muted">No teams yet.</p>}>
          <ul class="chips">
            <For each={props.detail.teams}>{(t) => <li class="chip">{t.name}</li>}</For>
          </ul>
        </Show>
        <Show when={isAdmin(props.detail)}>
          <form
            class="form-row"
            onSubmit={(e) => {
              e.preventDefault();
              void create.run(async () => {
                await api(`/api/orgs/${slug()}/teams`, ignored, {
                  method: "POST",
                  body: { name: name() },
                });
                setName("");
                props.onChange();
              });
            }}
          >
            <Field label="New team" error={create.error()}>
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
            <Button type="submit" disabled={create.busy()}>
              Create team
            </Button>
          </form>
          <form
            class="form-row"
            onSubmit={(e) => {
              e.preventDefault();
              void join.run(async () => {
                await api(`/api/orgs/${slug()}/teams/${teamId()}/members`, ignored, {
                  method: "POST",
                  body: { memberId: memberId() },
                });
                props.onChange();
              });
            }}
          >
            <Field label="Team">
              {(c) => (
                <select {...c()} required onChange={(e) => setTeamId(e.currentTarget.value)}>
                  <option value="">Choose…</option>
                  <For each={props.detail.teams}>
                    {(t) => <option value={t.id}>{t.name}</option>}
                  </For>
                </select>
              )}
            </Field>
            <Field label="Member" error={join.error()}>
              {(c) => (
                <select {...c()} required onChange={(e) => setMemberId(e.currentTarget.value)}>
                  <option value="">Choose…</option>
                  <For each={props.detail.members}>
                    {(m) => <option value={m.id}>@{m.handle}</option>}
                  </For>
                </select>
              )}
            </Field>
            <Button type="submit" disabled={join.busy()}>
              Add to team
            </Button>
          </form>
        </Show>
      </div>
    </Panel>
  );
}
