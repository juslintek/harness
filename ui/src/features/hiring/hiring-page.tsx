import { hireListSchema } from "@shared/hiring";
import { orgDetailSchema } from "@shared/orgs";
import { For, type JSX, Show } from "solid-js";
import { me } from "../../auth/me";
import { createLoad } from "../../load";
import { TableBox } from "../../ui/data-table";
import { Button, Panel, State, StatusBadge } from "../../ui/primitives";
import { fmtTime } from "../runs/format";
import { HireDetail } from "./hire-detail";
import { HIRE_TONE } from "./hire-phase";
import { NewHire } from "./new-hire";
import "../orgs/settings.css";
import "./hiring.css";

function HireList(props: { slug: string }): JSX.Element {
  const org = createLoad(() => `/api/orgs/${props.slug}`, orgDetailSchema);
  const hires = createLoad(() => `/api/orgs/${props.slug}/hires`, hireListSchema);
  const error = (): string | null => org.error() ?? hires.error();
  const teamName = (id: string): string => org.data()?.teams.find((t) => t.id === id)?.name ?? id;
  return (
    <div class="hiring">
      <h2 class="hiring-title">Hiring</h2>
      <Show when={error()}>
        {(message) => (
          <p class="form-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={org.data()}>
        {(detail) => (
          <Show when={detail().me.role !== "viewer"}>
            <NewHire detail={detail()} onFiled={() => void hires.reload()} />
          </Show>
        )}
      </Show>
      <Panel
        title="Requests"
        actions={
          <Button size="sm" onClick={() => void hires.reload()}>
            Refresh
          </Button>
        }
      >
        <Show
          when={hires.data()}
          fallback={
            <Show when={!error()}>
              <State kind="loading" />
            </Show>
          }
        >
          {(list) => (
            <Show when={list().length > 0} fallback={<p class="muted">No hiring requests yet.</p>}>
              <TableBox label="Hiring requests">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Team</th>
                    <th>Specialty</th>
                    <th>Filed</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={list()}>
                    {(h) => (
                      <tr>
                        <td>
                          <a class="hire-link" href={`#/o/${props.slug}/hiring/${h.id}`}>
                            {h.spec.title}
                          </a>
                        </td>
                        <td>{teamName(h.teamId)}</td>
                        <td class="mono">{h.spec.specialty}</td>
                        <td>{fmtTime(h.createdAt)}</td>
                        <td>
                          <StatusBadge tone={HIRE_TONE[h.status]} value={h.status} />
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </TableBox>
            </Show>
          )}
        </Show>
      </Panel>
    </div>
  );
}

export function HiringPage(props: { slug: string; id?: string }): JSX.Element {
  const known = (): boolean => me()?.orgs.some((o) => o.slug === props.slug) ?? false;
  return (
    <Show when={known()} fallback={<State kind="empty" message="Org not found" />}>
      <Show when={props.id} keyed fallback={<HireList slug={props.slug} />}>
        {(id) => <HireDetail slug={props.slug} id={id} />}
      </Show>
    </Show>
  );
}
