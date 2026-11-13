import { type JSX, Show } from "solid-js";
import { connection } from "../../realtime";
import { Button, CopyButton, Switch } from "../../ui/atoms";
import { ConnState } from "../../ui/molecules";
import { clockTime } from "./event-row";

function age(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  return seconds < 3600
    ? `${Math.floor(seconds / 60)} min ago`
    : `${Math.floor(seconds / 3600)} h ago`;
}

export function LiveStrip(props: {
  live: boolean;
  now: number;
  lastEvent: number | undefined;
  follow: boolean;
  onFollow: (next: boolean) => void;
  unseen: number;
  onJump: () => void;
  copyText: string;
}): JSX.Element {
  return (
    <div class="live-strip">
      <div class="live-strip-state">
        <Show when={props.live} fallback={<span>Run ended</span>}>
          <ConnState state={connection()} />
        </Show>
        <Show when={props.lastEvent}>
          {(at) => (
            <span class="live-strip-last mono">
              last event {clockTime(at())} · {age(props.now - at())}
            </span>
          )}
        </Show>
      </div>
      <div class="live-strip-actions">
        <Show when={!props.follow}>
          <Button size="sm" onClick={props.onJump}>
            {props.unseen > 0 ? `Jump to latest (${props.unseen} new)` : "Jump to latest"}
          </Button>
        </Show>
        <Switch label="Follow" checked={props.follow} onChange={props.onFollow} />
        <CopyButton text={props.copyText} label="Copy events" tone="ghost" />
      </div>
    </div>
  );
}
