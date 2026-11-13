import { createSignal, onCleanup } from "solid-js";

const [now, setNow] = createSignal(Date.now());
let users = 0;
let ticker: ReturnType<typeof setInterval> | undefined;

// One shared clock for everything counting down; it stops when the last user goes.
export function useNow(): () => number {
  if (users++ === 0) ticker = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => {
    if (--users === 0) clearInterval(ticker);
  });
  return now;
}

export const countdown = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
