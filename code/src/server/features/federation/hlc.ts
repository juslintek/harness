export type Hlc = string;

export interface HlcState {
  instanceId: string;
  ms: number;
  counter: number;
}

const MAX_SKEW_MS = 5 * 60_000;
const MAX_COUNTER = 9999;
const FORMAT = /^(\d{13})-(\d{4})-(.+)$/;

export function createHlcState(instanceId: string, ms = 0, counter = 0): HlcState {
  return { instanceId, ms, counter };
}

export function formatHlc(ms: number, counter: number, instanceId: string): Hlc {
  return `${String(ms).padStart(13, "0")}-${String(counter).padStart(4, "0")}-${instanceId}`;
}

export function parseHlc(hlc: Hlc): { ms: number; counter: number; instanceId: string } {
  const m = FORMAT.exec(hlc);
  if (!m) throw new Error(`bad hlc: ${hlc}`);
  return { ms: Number(m[1]), counter: Number(m[2]), instanceId: m[3] as string };
}

// Moves the state to (ms, counter) and returns the stamp. A full counter borrows the next
// millisecond so the stamp still grows.
function advance(state: HlcState, ms: number, counter: number): Hlc {
  let nextMs = ms;
  let nextCounter = counter;
  if (nextCounter > MAX_COUNTER) {
    nextMs += 1;
    nextCounter = 0;
  }
  state.ms = nextMs;
  state.counter = nextCounter;
  return formatHlc(nextMs, nextCounter, state.instanceId);
}

export function hlcNow(state: HlcState, wallMs: number): Hlc {
  if (wallMs > state.ms) return advance(state, wallMs, 0);
  return advance(state, state.ms, state.counter + 1);
}

export function hlcReceive(state: HlcState, remote: Hlc, wallMs: number): Hlc {
  const seen = parseHlc(remote);
  if (seen.ms > wallMs + MAX_SKEW_MS)
    throw new Error(`remote hlc is ahead of wall time: ${remote}`);
  const ms = Math.max(state.ms, seen.ms, wallMs);
  if (ms === wallMs && wallMs > state.ms && wallMs > seen.ms) return advance(state, ms, 0);
  const counters = [state.ms === ms ? state.counter : -1, seen.ms === ms ? seen.counter : -1];
  return advance(state, ms, Math.max(...counters) + 1);
}
