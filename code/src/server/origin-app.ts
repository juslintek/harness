import { Hono } from "hono";
import { isDirectLoopback, type PeerServer } from "./features/auth/api";
import { type AppDeps, createApp } from "./http";

export function createOriginApp(deps: AppDeps, currentOrigin: () => string): Hono {
  const localhost = `http://localhost:${deps.port}`;
  const build = (origin: string): Hono =>
    createApp({ ...deps, rp: { ...deps.rp, id: new URL(origin).hostname, origin } });
  const local = build(localhost);
  let publicOrigin = localhost;
  let publicApp = local;
  const app = new Hono();
  app.use("*", async (c) => {
    const origin = currentOrigin();
    if (c.req.header("host") === new URL(localhost).host) {
      const server = (c.env as { server?: PeerServer } | undefined)?.server;
      if (!isDirectLoopback(c.req.raw, server)) {
        return c.json({ error: "forbidden host" }, 403);
      }
      return local.fetch(c.req.raw, c.env);
    }
    if (origin !== publicOrigin) {
      publicApp = origin === localhost ? local : build(origin);
      publicOrigin = origin;
    }
    return publicApp.fetch(c.req.raw, c.env);
  });
  return app;
}
