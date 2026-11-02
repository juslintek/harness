const servers: ReturnType<typeof Bun.serve>[] = [];

async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/__ready`, { keepalive: false });
    return res.ok && (await res.text()) === "ok";
  } catch {
    return false;
  }
}

// Some hosts (sandboxes, local firewalls) block or reset traffic to a fresh
// loopback port for a while, which made the guard tests fail at random. A stub
// is only handed out once a probe has reached it; a blocked port is dropped and
// a new one is tried, so tests never depend on a port that is not serving.
export async function startStub(
  handler: (req: Request) => Response | Promise<Response>,
): Promise<{ calls: { n: number }; url: string }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const calls = { n: 0 };
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        if (new URL(req.url).pathname === "/__ready") return new Response("ok");
        calls.n++;
        return handler(req);
      },
    });
    servers.push(server);
    const url = `http://127.0.0.1:${server.port}`;
    if (await isReachable(url)) return { calls, url };
    await server.stop(true);
  }
  throw new Error("no loopback stub port became reachable");
}

export async function stopStubs(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
}
