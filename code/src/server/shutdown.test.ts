import { expect, test } from "bun:test";
import { drainStops } from "./shutdown";

test("shutdown waits for every loop stop promise", async () => {
  let resolveNotify!: () => void;
  let resolveBridge!: () => void;
  const notify = new Promise<void>((resolve) => (resolveNotify = resolve));
  const bridge = new Promise<void>((resolve) => (resolveBridge = resolve));
  let done = false;
  let calls = 0;
  const drained = drainStops(
    [
      () => {
        calls += 1;
        return notify;
      },
      () => {
        calls += 1;
        return bridge;
      },
    ],
    () => {},
  ).then(() => (done = true));
  await Promise.resolve();
  expect(calls).toBe(2);
  resolveNotify();
  await Promise.resolve();
  expect(done).toBe(false);
  resolveBridge();
  await drained;
  expect(done).toBe(true);
});
