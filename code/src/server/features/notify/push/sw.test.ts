import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../../../web/pwa/sw.js", import.meta.url), "utf8");

type Listener = (event: unknown) => void;

function load(openClients: { url: string }[] = []) {
  const listeners = new Map<string, Listener>();
  const shown: { title: string; opts: unknown }[] = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  let focused = 0;
  const clients = openClients.map((c) => ({
    ...c,
    focus: async () => void focused++,
    navigate: async (url: string) => void navigated.push(url),
  }));
  const self = {
    addEventListener: (name: string, fn: Listener) => listeners.set(name, fn),
    registration: {
      showNotification: async (title: string, opts: unknown) => void shown.push({ title, opts }),
    },
    clients: {
      matchAll: async () => clients,
      openWindow: async (url: string) => void opened.push(url),
    },
  };
  new Function("self", "location", "caches", "fetch", source)(
    self,
    { origin: "https://h.example.test" },
    {},
    async () => undefined,
  );
  const fire = async (name: string, event: Record<string, unknown>): Promise<void> => {
    const waits: Promise<unknown>[] = [];
    listeners.get(name)?.({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  return { fire, shown, opened, navigated, focused: () => focused };
}

const click = (url: string | undefined) => ({
  notification: { close: () => undefined, data: { url } },
});

test("push shows the payload with tag and url", async () => {
  const sw = load();
  const payload = { title: "T", body: "B", tag: "g", url: "https://h.example.test/#/a" };
  await sw.fire("push", { data: { json: () => payload } });
  expect(sw.shown).toEqual([
    { title: "T", opts: { body: "B", tag: "g", data: { url: "https://h.example.test/#/a" } } },
  ]);
});

test("push with an unreadable payload still shows a notification", async () => {
  const sw = load();
  const broken = {
    json: () => {
      throw new Error("x");
    },
  };
  await sw.fire("push", { data: broken });
  expect(sw.shown[0]?.title).toBe("harness");
});

test("click focuses an open client and navigates it", async () => {
  const sw = load([{ url: "https://h.example.test/#/home" }]);
  await sw.fire("notificationclick", click("https://h.example.test/#/approvals/1"));
  expect(sw.focused()).toBe(1);
  expect(sw.navigated).toEqual(["https://h.example.test/#/approvals/1"]);
  expect(sw.opened).toEqual([]);
});

test("click opens a window when none is open", async () => {
  const sw = load();
  await sw.fire("notificationclick", click("https://h.example.test/#/approvals/1"));
  expect(sw.opened).toEqual(["https://h.example.test/#/approvals/1"]);
});

test("click never leaves the origin", async () => {
  const sw = load();
  await sw.fire("notificationclick", click("https://evil.example.test/x"));
  await sw.fire("notificationclick", click(undefined));
  expect(sw.opened).toEqual(["https://h.example.test/", "https://h.example.test/"]);
});
