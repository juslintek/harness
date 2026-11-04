// Runs one fixed scenario against two servers and prints what differs after normalizing ids,
// times and tokens. Usage: bun conformance/differential.ts <a> <b>, where each side is `ts`, `zig`
// (booted here, seeded, with the stub agent) or the URL of a server that is already running with a
// stub agent `fake` and an admin session whose cookie is in HARNESS_DIFF_COOKIE.
import { api, type Endpoint, openWs, until } from "./kit/client";
import { fakeAgent, scratchRepo } from "./kit/fixtures";

type Repo = ReturnType<typeof scratchRepo>;

import { diff, type Json, normalizer } from "./kit/normalize";
import { seedSession } from "./kit/seed";
import { type Booted, boot, type Target } from "./kit/server";

const ENDED = new Set(["completed", "failed", "blocked", "cancelled", "killed"]);

interface Side {
  endpoint: Endpoint;
  cookie: string;
  stop: () => Promise<void>;
}

async function open(spec: string): Promise<Side> {
  if (spec === "ts" || spec === "zig") {
    let cookie = "";
    const server: Booted = await boot({
      target: spec satisfies Target,
      seed: (db) => {
        cookie = seedSession(db, { admin: true, stepUp: true }).cookie;
      },
      agents: [
        fakeAgent("fake", [{ say: "differential hello" }], `differential-${crypto.randomUUID()}`),
      ],
    });
    return { endpoint: server, cookie, stop: server.stop };
  }
  const url = new URL(spec);
  const port = Number(url.port);
  const loopback = ["127.0.0.1", "localhost"].includes(url.hostname);
  if (
    url.protocol !== "http:" ||
    !loopback ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(`${spec} is not http://127.0.0.1:<port>`);
  }
  const cookie = process.env.HARNESS_DIFF_COOKIE;
  if (!cookie) throw new Error("HARNESS_DIFF_COOKIE is required for a URL side");
  const endpoint = { port, base: `http://127.0.0.1:${port}`, origin: `http://localhost:${port}` };
  return { endpoint, cookie, stop: async () => {} };
}

interface Capture {
  http: Json;
  ws: Json;
}

async function capture(side: Side, repoPath: string): Promise<Capture> {
  const me = api(side.endpoint, { cookie: side.cookie });
  const numbered = normalizer();
  // The repo path differs per side by design, so it is masked before ids are numbered.
  const needle = JSON.stringify(repoPath).slice(1, -1);
  const norm = (value: Json): Json =>
    numbered(JSON.parse(JSON.stringify(value).replaceAll(needle, "<repo>")));
  const http: Record<string, Json> = {};
  const record = async (
    name: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Json> => {
    const res = await me.call(method, path, body === undefined ? {} : { body });
    const parsed = (await res.json()) as Json;
    http[name] = norm({ status: res.status, body: parsed });
    return parsed;
  };
  await record("health", "GET", "/api/health");
  await record("me", "GET", "/api/auth/me");
  const socket = await openWs(side.endpoint, "runs", { cookie: side.cookie });
  const started = (await record("start", "POST", "/api/runs", {
    agentId: "fake",
    repo: repoPath,
    prompt: "say hello",
  })) as { id: string };
  await until(async () => {
    const list = (await me.json("GET", "/api/runs")) as { id: string; state: string }[];
    return list.some((r) => r.id === started.id && ENDED.has(r.state));
  }, "the run to end");
  await record("detail", "GET", `/api/runs/${started.id}`);
  // The socket can lag the HTTP poll, so wait for the frame that carries the run's terminal state.
  await until(
    () =>
      (socket.frames as { type?: string; run?: { id: string; state: string } }[]).some(
        (f) => f.type === "run" && f.run?.id === started.id && ENDED.has(f.run.state),
      ),
    "the terminal run frame on the runs socket",
    5_000,
  );
  socket.close();
  // A run frame repeats whenever an event lands without changing the view, so repeats are dropped.
  const frames: Json[] = [];
  for (const frame of socket.frames as Json[]) {
    const next = norm(frame);
    if (JSON.stringify(next) !== JSON.stringify(frames.at(-1))) frames.push(next);
  }
  return { http, ws: frames };
}

// Each side gets its own repo, so an agent that mutates it cannot skew the other side's capture.
export async function compare(a: string, b: string): Promise<string[]> {
  const repos = [scratchRepo(), scratchRepo()];
  const sides: Side[] = [];
  try {
    for (const spec of [a, b]) sides.push(await open(spec));
    const [first, second] = [
      await capture(sides[0] as Side, (repos[0] as Repo).path),
      await capture(sides[1] as Side, (repos[1] as Repo).path),
    ];
    return [...diff(first.http, second.http, "http"), ...diff(first.ws, second.ws, "ws")];
  } finally {
    await Promise.all(sides.map((side) => side.stop()));
    for (const repo of repos) repo.remove();
  }
}

if (import.meta.main) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) {
    console.error("usage: bun conformance/differential.ts <ts|zig|url> <ts|zig|url>");
    process.exit(2);
  }
  const lines = await compare(a, b);
  console.log(lines.length === 0 ? "no differences" : lines.join("\n"));
  process.exit(lines.length === 0 ? 0 : 1);
}
