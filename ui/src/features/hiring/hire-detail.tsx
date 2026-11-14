import { hireViewSchema } from "@shared/hiring";
import { type OrgDetail, orgDetailSchema } from "@shared/orgs";
import { For, type JSX, Show } from "solid-js";
import { createLoad } from "../../load";
import { Notice, Panel, State } from "../../ui/molecules";
import { useCrumbName } from "../../ui/organisms";
import { FormError, isAdmin } from "../orgs/shared";
import { CandidateCard } from "./candidate-card";
import { DecidePanel } from "./decide-panel";
import { HireHeader } from "./hire-header";
import { hirePhase } from "./hire-phase";
import { HireResult } from "./hire-result";
import { ScoreTable } from "./score-table";
import "../orgs/settings.css";
import "../policies/policies.css";
import "./hiring.css";

// Names come from the hire's reviewers, so the line stays true when the list changes.
function scoringText(names: string[]): string {
  const who =
    names.length === 0
      ? ""
      : `${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`} ${names.length === 1 ? "is" : "are"} scoring. `;
  return `${who}You can add your own scorecard on each candidate below. This step ends when every reviewer has scored every candidate.`;
}

const tableTitle = (status: string): string =>
  status === "hired" || status === "rejected" ? "Candidates" : "Candidates side by side";

function DetailBody(props: { detail: OrgDetail; id: string }): JSX.Element {
  const slug = props.detail.org.slug;
  const base = `/api/orgs/${slug}/hires/${props.id}`;
  const hire = createLoad(base, hireViewSchema, [`org:${props.detail.org.id}`]);
  const handleOf = (memberId: string): string =>
    props.detail.members.find((m) => m.id === memberId)?.handle ?? memberId;
  const reload = (): void => void hire.reload();
  useCrumbName(() => hire.data()?.spec.title);
  return (
    <Show
      when={hire.data()}
      fallback={
        <>
          <FormError message={hire.error()} />
          <a class="hire-link" href={`#/o/${slug}/hiring`}>
            Back to requests
          </a>
          <Show when={!hire.error()}>
            <State kind="loading" />
          </Show>
        </>
      }
    >
      {(view) => (
        <>
          <HireHeader view={view()} slug={slug} onRefresh={reload} />
          <HireResult view={view()} detail={props.detail} />
          <Show when={hirePhase(view().status).scoring && isAdmin(props.detail)}>
            <Notice tone="info" title="Scoring is open">
              {scoringText(view().reviewers.map((r) => `@${handleOf(r.memberId)}`))}
            </Notice>
          </Show>
          <Show when={hirePhase(view().status).deciding && isAdmin(props.detail)}>
            <DecidePanel detail={props.detail} hire={view()} base={base} onDecided={reload} />
          </Show>
          <Show when={!hirePhase(view().status).deciding || !isAdmin(props.detail)}>
            <Panel title={tableTitle(view().status)}>
              <ScoreTable hire={view()} label="Candidate scores" />
            </Panel>
          </Show>
          <For each={view().candidates}>
            {(c) => (
              <CandidateCard
                hire={view()}
                candidate={c}
                base={base}
                canScore={isAdmin(props.detail) && hirePhase(view().status).scoring}
                handleOf={handleOf}
                onChange={reload}
              />
            )}
          </For>
        </>
      )}
    </Show>
  );
}

export function HireDetail(props: { slug: string; id: string }): JSX.Element {
  const org = createLoad(`/api/orgs/${props.slug}`, orgDetailSchema);
  return (
    <div class="hiring">
      <Show
        when={org.data()}
        fallback={
          <>
            <FormError message={org.error()} />
            <a class="hire-link" href={`#/o/${props.slug}/hiring`}>
              Back to requests
            </a>
            <Show when={!org.error()}>
              <State kind="loading" />
            </Show>
          </>
        }
      >
        {(detail) => <DetailBody detail={detail()} id={props.id} />}
      </Show>
    </div>
  );
}
