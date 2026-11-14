import { type JSX, Show } from "solid-js";
import { me } from "../../auth/me";
import { selectedSlug } from "../../orgs";
import { State } from "../../ui/molecules";
import { FinishedToday } from "./finished-today";
import { FirstRun } from "./first-run";
import { LimitsPanel } from "./limits-panel";
import { NeedsYou } from "./needs-you";
import { createNowData, type NowOrg } from "./now-data";
import { Queued } from "./queued";
import { QuietState } from "./quiet-state";
import { TopLine } from "./top-line";
import { WhereToLook } from "./where-to-look";
import { WorkingNow } from "./working-now";
import "./now.css";

function Now(props: { org: NowOrg }): JSX.Element {
  const data = createNowData(props.org);
  const detail = data.detail;
  const firstRun = (): boolean => {
    const loaded = detail.data();
    return (
      data.manager &&
      loaded !== undefined &&
      (loaded.projects.length === 0 || !loaded.members.some((m) => m.kind === "agent"))
    );
  };
  return (
    <div class="now">
      <Show when={detail.error()}>
        {(message) => (
          <State kind="error" message={message()} onRetry={() => void detail.reload()} />
        )}
      </Show>
      <Show when={detail.data()} fallback={<State kind={detail.error() ? "error" : "loading"} />}>
        <Show
          when={!firstRun()}
          fallback={<FirstRun data={data} slug={props.org.slug} name={props.org.name} />}
        >
          <div class="now-layout">
            <div class="now-main">
              <TopLine data={data} needs={data.needsCount()} />
              <Show when={data.needsCount() > 0}>
                <NeedsYou data={data} />
              </Show>
              <Show
                when={data.working().length > 0}
                fallback={<QuietState slug={props.org.slug} halted={data.halted()} />}
              >
                <WorkingNow data={data} />
              </Show>
              <Show when={data.queued().length > 0}>
                <Queued data={data} />
              </Show>
              <Show when={data.instanceAdmin}>
                <FinishedToday data={data} />
              </Show>
            </div>
            <aside class="now-side">
              <LimitsPanel data={data} slug={props.org.slug} />
              <WhereToLook slug={props.org.slug} />
            </aside>
          </div>
        </Show>
      </Show>
    </div>
  );
}

export function NowPage(): JSX.Element {
  const org = (): NowOrg | undefined => {
    const slug = selectedSlug();
    return me()?.orgs.find((o) => o.slug === slug);
  };
  return (
    <Show
      when={org()}
      keyed
      fallback={<State kind="empty" message="You are not in an organisation yet." />}
    >
      {(o) => <Now org={o} />}
    </Show>
  );
}
