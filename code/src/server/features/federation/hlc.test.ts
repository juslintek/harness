import { expect, test } from "bun:test";
import { createHlcState, hlcNow, hlcReceive, parseHlc } from "./hlc";

test("hlcNow stays monotonic when the wall clock goes backwards", () => {
  const state = createHlcState("a");
  const first = hlcNow(state, 5_000_000_000_000);
  const back = hlcNow(state, 4_000_000_000_000);
  const same = hlcNow(state, 5_000_000_000_000);
  const later = hlcNow(state, 5_000_000_000_001);
  expect([first, back, same, later]).toEqual([...[first, back, same, later]].sort());
  expect(new Set([first, back, same, later]).size).toBe(4);
  expect(parseHlc(first)).toEqual({ ms: 5_000_000_000_000, counter: 0, instanceId: "a" });
});

test("a full counter borrows the next millisecond", () => {
  const state = createHlcState("a", 5_000_000_000_000, 9999);
  expect(parseHlc(hlcNow(state, 5_000_000_000_000))).toMatchObject({
    ms: 5_000_000_000_001,
    counter: 0,
  });
});

test("hlcReceive moves past a remote ahead by less than 5 minutes", () => {
  const state = createHlcState("a");
  const remote = `${String(5_000_000_100_000).padStart(13, "0")}-0007-b`;
  const stamp = hlcReceive(state, remote, 5_000_000_000_000);
  expect(stamp > remote).toBe(true);
  expect(hlcNow(state, 5_000_000_000_000) > stamp).toBe(true);
});

test("hlcReceive rejects a remote more than 5 minutes ahead and leaves the state alone", () => {
  const state = createHlcState("a", 5_000_000_000_000, 3);
  const remote = `${String(5_000_000_000_000 + 5 * 60_000 + 1).padStart(13, "0")}-0000-b`;
  expect(() => hlcReceive(state, remote, 5_000_000_000_000)).toThrow("ahead");
  expect(state).toEqual({ instanceId: "a", ms: 5_000_000_000_000, counter: 3 });
});
