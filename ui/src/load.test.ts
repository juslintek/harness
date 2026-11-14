import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { z } from "zod";
import { createLoad, type Load } from "./load";

const schema = z.object({ n: z.number() });

function setup(): { load: Load<{ n: number }>; replies: ((res: Response) => void)[] } {
  const replies: ((res: Response) => void)[] = [];
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => replies.push(resolve))) as unknown as typeof fetch;
  const load = createRoot(() => createLoad("/api/x", schema));
  return { load, replies };
}

test("an older answer that arrives last does not replace the newer one", async () => {
  const { load, replies } = setup();
  const older = load.reload();
  const newer = load.reload();
  replies.at(-1)?.(Response.json({ n: 2 }));
  await newer;
  replies.at(-2)?.(Response.json({ n: 1 }));
  await older;
  expect(load.data()).toEqual({ n: 2 });
  expect(load.loading()).toBe(false);
});

test("a failed request sets the error, and a later good one clears it", async () => {
  const { load, replies } = setup();
  const failed = load.reload();
  replies.at(-1)?.(Response.json({ error: "boom" }, { status: 500 }));
  await failed;
  expect(load.error()).toBe("boom");
  expect(load.data()).toBeUndefined();
  const retried = load.reload();
  replies.at(-1)?.(Response.json({ n: 3 }));
  await retried;
  expect(load.error()).toBeNull();
  expect(load.data()).toEqual({ n: 3 });
});

test("with a filter only accepted messages refetch, and a reopened socket always does", async () => {
  const sockets: { onopen?: () => void; onmessage?: (e: { data: string }) => void }[] = [];
  globalThis.WebSocket = class {
    onopen?: () => void;
    onmessage?: (e: { data: string }) => void;
    constructor() {
      sockets.push(this);
    }
    close(): void {}
  } as unknown as typeof WebSocket;
  Object.assign(globalThis, { location: { protocol: "http:", host: "h" } });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({ n: calls });
  }) as unknown as typeof fetch;
  const load = createRoot(() =>
    createLoad("/api/x", schema, ["org:1"], (f) => f.type === "memory"),
  );
  const socket = sockets[0];
  if (!socket) throw new Error("no socket opened");
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  await load.reload();
  socket.onopen?.();
  socket.onmessage?.({ data: JSON.stringify({ type: "chat" }) });
  await settle();
  expect(calls).toBe(1);
  socket.onmessage?.({ data: JSON.stringify({ type: "memory" }) });
  await settle();
  expect(calls).toBe(2);
  socket.onopen?.();
  await settle();
  expect(calls).toBe(3);
});
