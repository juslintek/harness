import "../../test-support/no-git-env";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { startMemory } from "./api";
import * as reconcileModule from "./reconcile";
import { type Env, setup, teardown } from "./store-test-kit";
import * as watcherModule from "./watcher";

let env: Env;
beforeEach(() => {
  env = setup();
});
afterEach(() => teardown(env));

// A file written while reconcile walks the vault is missed on platforms whose watcher only reports
// changes made after it attached (inotify), so the watcher has to exist before reconcile starts.
test("startMemory attaches the watcher before it reconciles", async () => {
  const order: string[] = [];
  const watch = watcherModule.watchVault;
  const walk = reconcileModule.reconcile;
  const spies = [
    spyOn(watcherModule, "watchVault").mockImplementation((...args) => {
      order.push("watch");
      return watch(...args);
    }),
    spyOn(reconcileModule, "reconcile").mockImplementation((...args) => {
      order.push("reconcile");
      return walk(...args);
    }),
  ];
  try {
    await startMemory(env.db, { home: env.dir })();
  } finally {
    for (const s of spies) s.mockRestore();
  }
  expect(order).toEqual(["watch", "reconcile"]);
});

test("startMemory closes the watcher when reconcile throws", () => {
  let closed = false;
  const spies = [
    spyOn(watcherModule, "watchVault").mockImplementation(() => () => {
      closed = true;
    }),
    spyOn(reconcileModule, "reconcile").mockImplementation(() => {
      throw new Error("boom");
    }),
  ];
  try {
    expect(() => startMemory(env.db, { home: env.dir })).toThrow("boom");
  } finally {
    for (const s of spies) s.mockRestore();
  }
  expect(closed).toBe(true);
});
