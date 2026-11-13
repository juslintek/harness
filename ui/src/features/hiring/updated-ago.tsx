import { createEffect, createSignal, type JSX, on, onCleanup } from "solid-js";
import { Button } from "../../ui/atoms";

// `stamp` is the loaded data: each new value restarts the clock, so it reads how old the screen is.
export function UpdatedAgo(props: { stamp: () => unknown; onRefresh: () => void }): JSX.Element {
  const [at, setAt] = createSignal(Date.now());
  const [now, setNow] = createSignal(Date.now());
  createEffect(on(props.stamp, () => setAt(Date.now())));
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));
  const age = (): string => {
    const s = Math.max(0, Math.floor((now() - at()) / 1000));
    return s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ago`;
  };
  return (
    <span class="updated-ago">
      <span class="muted-line">Updated {age()}</span>
      <Button size="sm" tone="ghost" onClick={props.onRefresh}>
        Refresh
      </Button>
    </span>
  );
}
