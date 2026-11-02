import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { type AuthEnv, createSession, type Session } from "../features/auth/api";
import { type createApp, MAX_REQUEST_BODY_BYTES } from "../http";
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
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
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

export interface SessionOpts {
  admin?: boolean;
  stepUp?: boolean;
  // When given, the headers also carry the Host and Origin the app expects for it.
  origin?: string;
}

// Writes the user and session straight to the DB, so tests need no passkey ceremony to be logged in.
export async function sessionHeaders(
  db: Database,
  opts: SessionOpts = {},
): Promise<{ headers: Record<string, string>; userId: string }> {
  const userId = Bun.randomUUIDv7();
  db.query(
    "INSERT INTO users (id, email, name, instance_admin, created_at) VALUES (?, ?, 'Test', ?, ?)",
  ).run(userId, `${userId}@example.test`, opts.admin ? 1 : 0, Date.now());
  const { token, id } = createSession(db, userId, "passkey", null);
  if (opts.stepUp) {
    db.query("UPDATE sessions SET step_up_at = ? WHERE id = ?").run(Date.now(), id);
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    cookie: `harness_session=${token}`,
    ...(opts.origin ? { host: new URL(opts.origin).host, origin: opts.origin } : {}),
  };
  return { headers, userId };
}

// Route modules read the actor the session middleware would set; this stands one in for them.
export function withActor(routes: Hono<AuthEnv>, session: Partial<Session> = {}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", {
      id: "s1",
      userId: "u1",
      method: "passkey",
      stepUpAt: Date.now(),
      instanceAdmin: true,
      ...session,
    });
    await next();
  });
  app.route("/", routes);
  return app;
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
