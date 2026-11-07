export const MIN_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 30_000;

// Tests replace the wait so reconnect timing can be asserted without real delays.
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export const waitFor: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
