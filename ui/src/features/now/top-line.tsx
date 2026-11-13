import type { JSX } from "solid-js";
import type { NowData } from "./now-data";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function TopLine(props: { data: NowData; needs: number }): JSX.Element {
  const d = (): NowData => props.data;
  return (
    <p class="now-top-line">
      {d().instanceAdmin ? (
        <>
          <span>{d().running()} running</span>
          <span data-warn={props.needs > 0 ? "" : undefined}>{props.needs} need you</span>
          <span>{d().failedToday()} failed today</span>
        </>
      ) : (
        <>
          <span>{plural(d().working().length, "agent working", "agents working")}</span>
          <span>{d().queued().length} queued</span>
          <span>{plural(d().myBlocked().length, "task blocked", "tasks blocked")}</span>
        </>
      )}
    </p>
  );
}
