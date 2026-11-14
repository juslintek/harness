import { type HireView, hireListSchema } from "@shared/hiring";
import { type OrgDetail, orgDetailSchema } from "@shared/orgs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { me } from "../../auth/me";
import { createLoad } from "../../load";
import { Button, ButtonLink, Help } from "../../ui/atoms";
import { Notice, Panel, State, TableBox } from "../../ui/molecules";
import { FormError, isAdmin } from "../orgs/shared";
import { HireDetail } from "./hire-detail";
import { sortHires } from "./hire-phase";
import { HowHiringWorks } from "./how-hiring-works";
import { NewHire, specialtyFromLink } from "./new-hire";
import { RequestRow } from "./request-row";
import { UpdatedAgo } from "./updated-ago";
import "../orgs/settings.css";
import "./hiring.css";

function Requests(props: {
  detail: OrgDetail;
  list: HireView[];
  reload: () => void;
  showForm: () => boolean;
}): JSX.Element {
  const slug = (): string => props.detail.org.slug;
  const admin = (): boolean => isAdmin(props.detail);
  const teamName = (id: string): string => props.detail.teams.find((t) => t.id === id)?.name ?? id;
  const sorted = (): HireView[] => sortHires(props.list);
  const waiting = (): HireView[] =>
    admin() ? props.list.filter((h) => h.status === "deciding") : [];
  const first = (): HireView | undefined => sortHires(waiting())[0];
  return (
    <>
      <Show when={first()}>
        {(h) => (
          <Notice
            tone="warning"
            title={`${waiting().length} ${waiting().length === 1 ? "request needs" : "requests need"} your decision`}
            actions={
              <ButtonLink href={`#/o/${slug()}/hiring/${h().id}`}>Open {h().spec.title}</ButtonLink>
            }
          >
            {h().spec.title} (team {teamName(h().teamId)}) finished scoring. Choose a candidate or
            reject all.
          </Notice>
        )}
      </Show>
      <Show when={props.showForm()}>
        <NewHire detail={props.detail} onFiled={props.reload} />
      </Show>
      <Panel
        title="Requests"
        actions={<UpdatedAgo stamp={() => props.list} onRefresh={props.reload} />}
      >
        <div class="stack">
          <Show
            when={props.list.length > 0}
            fallback={
              <State
                kind="empty"
                title="No hiring requests yet"
                message="Hiring lets you try candidate agents before you add one: each answers questions about the role, reviewers score them, then you decide."
              />
            }
          >
            <Help>Requests that wait for you come first, then open ones, then closed ones.</Help>
            <TableBox stack label="Hiring requests">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Team</th>
                  <th>Specialty</th>
                  <th>Filed</th>
                  <th>Where it is</th>
                  <th>Status</th>
                  <th>
                    <span class="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={sorted()}>
                  {(h) => (
                    <RequestRow
                      hire={h}
                      slug={slug()}
                      team={teamName(h.teamId)}
                      canDecide={admin()}
                    />
                  )}
                </For>
              </tbody>
            </TableBox>
          </Show>
        </div>
      </Panel>
    </>
  );
}

function HireList(props: { slug: string }): JSX.Element {
  const org = createLoad(() => `/api/orgs/${props.slug}`, orgDetailSchema);
  return (
    <div class="hiring">
      <FormError message={org.error()} />
      <Show
        when={org.data()}
        fallback={
          <Show when={!org.error()}>
            <State kind="loading" />
          </Show>
        }
      >
        {(detail) => <HireListBody detail={detail()} />}
      </Show>
    </div>
  );
}

function HireListBody(props: { detail: OrgDetail }): JSX.Element {
  const hires = createLoad(`/api/orgs/${props.detail.org.slug}/hires`, hireListSchema, [
    `org:${props.detail.org.id}`,
  ]);
  const [opened, setOpened] = createSignal(specialtyFromLink() !== undefined);
  const canFile = (): boolean => props.detail.me.role !== "viewer";
  // The form is open while nothing was filed yet, and behind "New hire" after that.
  const showForm = (): boolean => canFile() && (opened() || hires.data()?.length === 0);
  return (
    <>
      <div class="hiring-intro">
        <Help>
          Try candidate agents before you add one. Each is interviewed and scored, then you decide.
        </Help>
        <Show when={canFile() && (hires.data()?.length ?? 0) > 0}>
          <Button aria-expanded={opened()} onClick={() => setOpened(!opened())}>
            New hire
          </Button>
        </Show>
      </div>
      <FormError message={hires.error()} />
      <Show
        when={hires.data()}
        fallback={
          <Show when={!hires.error()}>
            <State kind="loading" />
          </Show>
        }
      >
        {(list) => (
          <Requests
            detail={props.detail}
            list={list()}
            reload={() => void hires.reload()}
            showForm={showForm}
          />
        )}
      </Show>
      <HowHiringWorks />
    </>
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
