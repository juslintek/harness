// HTTP and WebSocket access the way the browser has it: sockets go to the loopback address, while
// Host and Origin carry the RP origin the host and origin guards compare against.
import type { SeededSession } from "./seed";
import type { Booted } from "./server";

// A running server is all a scenario needs, whether it was booted here or was already up.
export type Endpoint = Pick<Booted, "port" | "base" | "origin">;
type Cookie = Pick<SeededSession, "cookie">;

interface CallOpts {
  body?: unknown;
  // A null value removes a header the client would otherwise send.
  headers?: Record<string, string | null>;
}

export interface Api {
  call: (method: string, path: string, opts?: CallOpts) => Promise<Response>;
  json: <T = unknown>(method: string, path: string, opts?: CallOpts) => Promise<T>;
}

export function headersFor(
  server: Endpoint,
  session: Cookie | undefined,
  extra: Record<string, string | null> = {},
): Record<string, string> {
  const merged: Record<string, string | null> = {
    host: new URL(server.origin).host,
    origin: server.origin,
    ...(session ? { cookie: session.cookie } : {}),
    ...extra,
  };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) if (value !== null) out[key] = value;
  return out;
}

export function api(server: Endpoint, session?: Cookie): Api {
  const call: Api["call"] = (method, path, opts = {}) =>
    fetch(`${server.base}${path}`, {
      method,
      redirect: "manual",
      headers: headersFor(server, session, {
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        ...opts.headers,
      }),
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
  return {
    call,
    async json<T>(method: string, path: string, opts?: CallOpts): Promise<T> {
      const res = await call(method, path, opts);
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
      return JSON.parse(text) as T;
    },
  };
}

export async function until<T>(
  probe: () => T | Promise<T>,
  what: string,
  ms = 20_000,
): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

export interface Socket {
  frames: unknown[];
  closed: Promise<number>;
  close: () => void;
}

export function openWs(
  server: Endpoint,
  topic: string,
  session: Cookie,
  extra: Record<string, string | null> = {},
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${server.port}/ws?topic=${encodeURIComponent(topic)}`;
    // Bun takes handshake headers in the options form, which the DOM typings do not know.
    const ws = new WebSocket(url, {
      headers: headersFor(server, session, extra),
    } as unknown as string[]);
    const frames: unknown[] = [];
    const closed = new Promise<number>((done) => {
      ws.onclose = (event) => done(event.code);
    });
    ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
    ws.onopen = () => resolve({ frames, closed, close: () => ws.close() });
    ws.onerror = () => reject(new Error(`websocket ${topic} was refused`));
  });
}
