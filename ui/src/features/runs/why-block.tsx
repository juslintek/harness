import { type JSX, Show } from "solid-js";
import { Panel } from "../../ui/molecules";
import type { Wakeup } from "../../wakeups";
import type { Why } from "./data";
import { clockTime } from "./event-row";
import { Fact } from "./fact";

export function WhyBlock(props: {
  why: Why | undefined;
  wakeup: Wakeup | undefined;
  taskNumber: number | null | undefined;
}): JSX.Element {
  return (
    <Show when={props.why && props.wakeup}>
      <Panel title="Why it started">
        <dl class="facts">
          <Fact label="Reason">{props.why?.text}</Fact>
          <Show
            when={props.taskNumber !== null && props.taskNumber !== undefined && props.why?.href}
          >
            <Fact label="Task">
              <a href={props.why?.href}>#{props.taskNumber}</a>
            </Fact>
          </Show>
          <Fact label="Woken at">
            <span class="mono">{clockTime(props.wakeup?.createdAt ?? 0)}</span>
          </Fact>
        </dl>
      </Panel>
    </Show>
  );
}
