import type { createApp } from "../http";
import { websocket } from "../realtime";

// The listener is bound first and the app is attached once the port is known. Probing for a free
// port and binding it later raced with other processes taking that port in between.
export function listenDeferred(): {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  attach: (app: ReturnType<typeof createApp>) => void;
} {
  let current: ReturnType<typeof createApp> | undefined;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, srv) =>
      current ? current.fetch(req, { server: srv }) : new Response("not ready", { status: 503 }),
    websocket,
  });
  return {
    server,
    port: server.port as number,
    attach: (app) => {
      current = app;
    },
  };
}

export async function adminHeaders(
  app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> },
  port: number,
  secret: string,
): Promise<Record<string, string>> {
  const host = `127.0.0.1:${port}`;
  const res = await app.request(`/login?k=${secret}`, { headers: { host } });
  return {
    host,
    origin: `http://127.0.0.1:${port}`,
    "content-type": "application/json",
    cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
  };
}

export function openSocket(url: string, headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    // Bun accepts handshake headers here; the DOM typings do not know the options form.
    const ws = new WebSocket(url, { headers } as unknown as string[]);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws rejected"));
  });
}

export async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(20);
  }
}
