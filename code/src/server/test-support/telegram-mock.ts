interface ScriptedReply {
  status?: number;
  json: Record<string, unknown>;
}

export interface TelegramMock {
  url: string;
  token: string;
  sent: { chat_id: string; text: string }[];
  polls: { offset: number | null; timeout: number | null }[];
  sendReplies: ScriptedReply[];
  // Number of upcoming getUpdates calls that fail with a 500.
  failPolls: { n: number };
  // Queues an update and returns its update_id; it is served again until a poll confirms it.
  enqueue: (update: Record<string, unknown>) => number;
  stop: () => Promise<void>;
}

type State = Pick<TelegramMock, "token" | "sent" | "polls" | "sendReplies" | "failPolls">;
type Queued = { update_id: number };

const denied = (): Response =>
  Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });

async function getUpdates(s: State, queue: Queued[], url: URL): Promise<Response> {
  const num = (key: string): number | null =>
    url.searchParams.has(key) ? Number(url.searchParams.get(key)) : null;
  const offset = num("offset");
  s.polls.push({ offset, timeout: num("timeout") });
  if (s.failPolls.n > 0) {
    s.failPolls.n--;
    return Response.json({ ok: false, error_code: 500, description: "boom" }, { status: 500 });
  }
  // Real Telegram drops updates below the offset; an empty queue is a held request, shortened here.
  while (queue[0] && queue[0].update_id < (offset ?? 0)) queue.shift();
  if (queue.length === 0) await Bun.sleep(15);
  return Response.json({ ok: true, result: queue });
}

async function sendMessage(s: State, req: Request): Promise<Response> {
  s.sent.push((await req.json()) as { chat_id: string; text: string });
  const scripted = s.sendReplies.shift();
  if (!scripted) return Response.json({ ok: true, result: { message_id: 1 } });
  return Response.json(scripted.json, { status: scripted.status ?? 200 });
}

// Speaks just enough of the Bot API for the adapter and bridge tests. The token sits in the path.
export function startTelegramMock(token = "123456:test-bot-token"): TelegramMock {
  const state: State = { token, sent: [], polls: [], sendReplies: [], failPolls: { n: 0 } };
  const queue: Queued[] = [];
  let nextId = 100;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      const [, bot, method] = url.pathname.split("/");
      if (bot !== `bot${token}`) return denied();
      if (method === "getMe") return Response.json({ ok: true, result: { id: 999, is_bot: true } });
      if (method === "getUpdates") return getUpdates(state, queue, url);
      if (method === "sendMessage") return sendMessage(state, req);
      return new Response("not found", { status: 404 });
    },
  });
  return {
    ...state,
    url: `http://127.0.0.1:${server.port}`,
    enqueue: (update) => {
      const update_id = nextId++;
      queue.push({ ...update, update_id });
      return update_id;
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}
