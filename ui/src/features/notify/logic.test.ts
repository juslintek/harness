import { expect, test } from "bun:test";
import { applicationServerKey, gridRows, needsHomeScreen, pushState, withPref } from "./logic";

test("applicationServerKey decodes unpadded base64url", () => {
  // "-__-" uses both url-safe characters; "AQI" needs its padding restored.
  expect([...applicationServerKey("-__-")]).toEqual([0xfb, 0xff, 0xfe]);
  expect([...applicationServerKey("AQI")]).toEqual([1, 2]);
});

test("gridRows has a cell for every kind and channel, missing ones off", () => {
  const rows = gridRows([{ channel: "push", kind: "dm", enabled: true }]);
  expect(rows).toHaveLength(6);
  expect(rows.every((r) => r.cells.length === 5)).toBe(true);
  const dm = rows.find((r) => r.kind === "dm");
  expect(dm?.cells.find((c) => c.channel === "push")?.enabled).toBe(true);
  expect(dm?.cells.find((c) => c.channel === "email")?.enabled).toBe(false);
});

test("withPref replaces one pair and keeps the rest", () => {
  const before = [
    { channel: "push" as const, kind: "dm" as const, enabled: true },
    { channel: "email" as const, kind: "dm" as const, enabled: false },
  ];
  const after = withPref(before, { channel: "push", kind: "dm", enabled: false });
  expect(after).toHaveLength(2);
  expect(after.find((p) => p.channel === "push")?.enabled).toBe(false);
});

test("pushState tells unsupported, denied, subscribed and ready apart", () => {
  const base = {
    hasServiceWorker: true,
    hasPushManager: true,
    hasNotification: true,
    permission: "default" as const,
    subscribed: false,
  };
  expect(pushState(base)).toBe("ready");
  expect(pushState({ ...base, subscribed: true })).toBe("subscribed");
  expect(pushState({ ...base, permission: "denied" })).toBe("denied");
  expect(pushState({ ...base, hasPushManager: false })).toBe("unsupported");
});

test("needsHomeScreen is true only for iOS outside an installed web app", () => {
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";
  expect(needsHomeScreen(iphone, false)).toBe(true);
  expect(needsHomeScreen(iphone, true)).toBe(false);
  expect(needsHomeScreen("Mozilla/5.0 (Macintosh)", false)).toBe(false);
});
