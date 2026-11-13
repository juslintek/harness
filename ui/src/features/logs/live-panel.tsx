import { runViewSchema } from "@shared/runs";
import { For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { createLoad } from "../../load";
import { Help } from "../../ui/atoms";
import { Panel } from "../../ui/molecules";
import { FollowRow } from "./follow-row";

const LIVE = new Set(["queued", "starting", "running"]);
const runsSchema = z.array(runViewSchema);

// Search does not update by itself; a running run has its own live page.
export function LivePanel(props: { admin: boolean }): JSX.Element {
  return (
    <Panel title="Want to watch live? Follow a running run">
      <Help>
        Logs are searched, not streamed. To see output as it happens, open a running run and turn on
        Follow.
      </Help>
      <Show when={props.admin}>
        <LiveRuns />
      </Show>
      <Help small>Runs are visible to instance admins.</Help>
    </Panel>
  );
}

function LiveRuns(): JSX.Element {
  const runs = createLoad("/api/runs", runsSchema, ["runs"]);
  const live = (): z.infer<typeof runsSchema> =>
    (runs.data() ?? []).filter((r) => LIVE.has(r.state));
  return (
    <Show when={live().length > 0} fallback={<p class="muted">No run is running now.</p>}>
      <ul class="logs-live" aria-label="Running runs">
        <For each={live()}>{(r) => <FollowRow run={r} />}</For>
      </ul>
    </Show>
  );
}
