import type { JSX } from "solid-js";
import { type Connection, lastLiveAt } from "../../realtime";
import { Dot } from "../atoms";
import "./conn-state.css";

const TONE = { live: "success", reconnecting: "warning", offline: "danger" } as const;

const hhmm = (d: Date): string =>
  d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

// Only a change away from live is announced; "Live" on every page would be noise for screen readers.
export function ConnState(props: { state: Connection }): JSX.Element {
  return (
    <div class="conn-state" role={props.state === "live" ? undefined : "status"}>
      <Dot tone={TONE[props.state]} />
      <span>
        {props.state === "live" && "Live"}
        {props.state === "reconnecting" && "Reconnecting…"}
        {props.state === "offline" && `Offline · data from ${hhmm(lastLiveAt())}`}
      </span>
    </div>
  );
}
