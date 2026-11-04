interface PostReply {
  status?: number;
  headers?: Record<string, string>;
  json: Record<string, unknown>;
}

export interface SlackMock {
  url: string;
  appToken: string;
  botToken: string;
  posts: { auth: string; body: Record<string, unknown> }[];
  opens: { auth: string }[];
  acks: string[];
  postReplies: PostReply[];
  // Number of upcoming apps.connections.open calls that fail.
  failOpens: { n: number };
  sockets: () => number;
  push: (payload: unknown, envelopeId?: string) => void;
  drop: () => void;
  stop: () => Promise<void>;
}

export async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("until: timed out");
    await Bun.sleep(5);
  }
}

type State = Pick<
  SlackMock,
  "posts" | "opens" | "acks" | "postReplies" | "failOpens" | "appToken" | "botToken"
>;

const bad = (): Response => Response.json({ ok: false, error: "invalid_auth" });

function openConnection(s: State, auth: string, port: number): Response {
  s.opens.push({ auth });
  if (auth !== `Bearer ${s.appToken}`) return bad();
  if (s.failOpens.n > 0) {
    s.failOpens.n--;
    return Response.json({ ok: false, error: "internal_error" }, { status: 500 });
  }
  return Response.json({ ok: true, url: `ws://127.0.0.1:${port}/ws` });
}

async function postMessage(s: State, req: Request, auth: string): Promise<Response> {
  s.posts.push({ auth, body: (await req.json()) as Record<string, unknown> });
  if (auth !== `Bearer ${s.botToken}`) return bad();
  const scripted = s.postReplies.shift();
  if (!scripted) return Response.json({ ok: true, ts: "1.1" });
  return Response.json(scripted.json, {
    status: scripted.status ?? 200,
    headers: scripted.headers ?? {},
  });
}

// Speaks just enough of Slack's Web API and Socket Mode for the adapter and bridge tests.
export function startSlackMock(botToken = "xoxb-test-bot", appToken = "xapp-test-app"): SlackMock {
  const state: State = {
    posts: [],
    opens: [],
    acks: [],
    postReplies: [],
    failOpens: { n: 0 },
    appToken,
    botToken,
  };
  const live = new Set<Bun.ServerWebSocket<undefined>>();

  const server = Bun.serve<undefined>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const path = new URL(req.url).pathname;
      const auth = req.headers.get("authorization") ?? "";
      if (path === "/ws") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      if (path === "/api/apps.connections.open")
        return openConnection(state, auth, srv.port as number);
      if (path === "/api/chat.postMessage") return postMessage(state, req, auth);
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open: (ws) => {
        live.add(ws);
        ws.send(JSON.stringify({ type: "hello" }));
      },
      message: (_ws, raw) => {
        const ack = JSON.parse(String(raw)) as { envelope_id?: string };
        if (ack.envelope_id) state.acks.push(ack.envelope_id);
      },
      close: (ws) => {
        live.delete(ws);
      },
    },
  });

  return {
    ...state,
    url: `http://127.0.0.1:${server.port}`,
    sockets: () => live.size,
    push: (payload, envelopeId = Bun.randomUUIDv7()) => {
      const text = JSON.stringify({ envelope_id: envelopeId, type: "events_api", payload });
      for (const ws of live) ws.send(text);
    },
    drop: () => {
      for (const ws of live) ws.close();
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}
