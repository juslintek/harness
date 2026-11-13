import type { JSX } from "solid-js";
import { createLoad } from "../../load";
import { orgUrl, targetsSchema } from "./data";
import { PrefsGrid } from "./prefs";
import { Targets } from "./targets";

// Both panels read the same targets: a channel with none cannot deliver, so its choices are off.
export function NotifySection(props: { org: string; picker?: JSX.Element }): JSX.Element {
  const targets = createLoad(orgUrl("/api/notify/targets", props.org), targetsSchema);
  return (
    <>
      <PrefsGrid org={props.org} targets={targets.data()} picker={props.picker} />
      <Targets
        org={props.org}
        targets={targets.data()}
        error={targets.error()}
        onChange={() => targets.reload()}
      />
    </>
  );
}
