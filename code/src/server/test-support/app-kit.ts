export function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const free = probe.port ?? 0;
  void probe.stop(true);
  return free;
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
