// The two in-process instances of Gate 6 and what they are seeded with. A sits behind a
// recording proxy so the gate can read every feed body A answers.
import { join } from "node:path";
import { setSecret } from "../src/server/features/agents/api";
import { addComment, addDependency, createTask, getTask } from "../src/server/features/board/api";
import { ensureProjectChannel, postMessage } from "../src/server/features/chat/api";
import { startFederation } from "../src/server/features/federation/api";
import {
  createNote,
  projectSlugs,
  readNoteText,
  resolveNotePath,
  type Viewer,
} from "../src/server/features/memory/api";
import { createOrg, createProject, memberForUser } from "../src/server/features/orgs/api";
import { bootInstance, enrollAdmin, type Instance, stepUp } from "./gate-5-kit";
import { git, tempDir } from "./gate-6-kit";

export interface Side {
  inst: Instance;
  cookie: string;
  id: string;
  stopLoops: () => Promise<void>;
}

// Records what A answers to B. B's own url for A is the proxy, so A's origin is the proxy's.
export function startRecorder(): {
  port: number;
  bodies: string[];
  upstream: { port: number };
  stop: () => void;
} {
  const bodies: string[] = [];
  const upstream = { port: 0 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const sent = await fetch(`http://127.0.0.1:${upstream.port}${url.pathname}${url.search}`, {
        method: req.method,
        headers: req.headers,
        ...(req.method === "GET" ? {} : { body: await req.arrayBuffer() }),
      }).catch(() => null);
      if (!sent) return new Response("upstream down", { status: 502 });
      const text = await sent.text();
      if (url.pathname.startsWith("/federation/")) bodies.push(text);
      return new Response(text, {
        status: sent.status,
        headers: { "content-type": sent.headers.get("content-type") ?? "application/json" },
      });
    },
  });
  return { port: server.port as number, bodies, upstream, stop: () => void server.stop(true) };
}

export async function boot(name: string, origin?: string): Promise<Side> {
  const inst = await bootInstance({
    home: join(tempDir(name), "home"),
    ...(origin ? { origin } : {}),
  });
  const { cookie } = await enrollAdmin(inst);
  await stepUp(inst, cookie);
  const id = inst.db.query<{ id: string }, []>("SELECT id FROM instance").get()?.id ?? "";
  const stopLoops = startFederation(inst.db, {
    home: inst.home,
    pullIntervalMs: 250,
    leaseIntervalMs: 500,
  });
  return { inst, cookie, id, stopLoops };
}

export const stubMember = (side: Side, userId: string): string | undefined =>
  side.inst.db
    .query<{ id: string }, [string, string]>(
      `SELECT m.id FROM members m JOIN orgs o ON o.id = m.org_id
       WHERE o.home_instance = ? AND m.user_id = ?`,
    )
    .get(side.id, userId)?.id;

export const titleOf = (side: Side, id: string): string | undefined =>
  getTask(side.inst.db, id)?.title;
export const holderOf = (side: Side, id: string): string | null | undefined =>
  getTask(side.inst.db, id)?.holderId;

export interface Seeded {
  orgId: string;
  projectId: string;
  member: string;
  viewer: Viewer;
  tasks: string[];
  disk: string;
}

export async function seedA(a: Side, secret: string): Promise<Seeded> {
  setSecret("gate6.test-secret", secret, a.inst.home);
  const repo = tempDir("a-repo");
  git(repo, "init", "-q");
  const userId = (
    a.inst.db.query<{ id: string }, []>("SELECT id FROM users").get() as { id: string }
  ).id;
  const org = createOrg(a.inst.db, {
    name: "Acme",
    slug: "acme",
    ownerUserId: userId,
    ownerName: "Ann",
    ownerHandle: "ann",
  });
  const member = memberForUser(a.inst.db, org.id, userId)?.id ?? "";
  const project = createProject(a.inst.db, { orgId: org.id, key: "ENG", name: "Eng", repo });
  const channel = ensureProjectChannel(a.inst.db, project.id).id;
  const base = { projectId: project.id, createdBy: member };
  const first = createTask(a.inst.db, { ...base, title: "first" });
  const second = createTask(a.inst.db, { ...base, title: "second" });
  addDependency(a.inst.db, second.id, first.id);
  addComment(a.inst.db, first.id, member, "hello from A");
  postMessage(a.inst.db, { channelId: channel, authorId: member, body: "hi team" });
  const viewer: Viewer = {
    orgId: org.id,
    memberId: null,
    projectIds: [project.id],
    canWriteGlobal: false,
    canWrite: true,
    actor: "ann",
  };
  const loc = resolveNotePath(
    "/memories/project/ENG/plan.md",
    viewer,
    projectSlugs(a.inst.db, org.id),
  );
  if (loc === null || loc === "dir") throw new Error("bad note path");
  await createNote(
    a.inst.db,
    a.inst.home,
    { viewer, runId: null },
    loc,
    "# Plan\n\nship the zebra release",
  );
  return {
    orgId: org.id,
    projectId: project.id,
    member,
    viewer,
    tasks: [first.id, second.id],
    disk: loc.disk,
  };
}

const column = (side: Side, sql: string, id: string): string[] =>
  side.inst.db
    .query<{ v: string }, [string]>(sql)
    .all(id)
    .map((r) => r.v);

export function sameContent(a: Side, b: Side, s: Seeded): boolean {
  const queries = [
    "SELECT title AS v FROM tasks WHERE project_id = ? ORDER BY id",
    "SELECT c.body AS v FROM comments c JOIN tasks t ON t.id = c.task_id WHERE t.project_id = ? ORDER BY c.id",
    "SELECT x.body AS v FROM messages x JOIN channels ch ON ch.id = x.channel_id WHERE ch.project_id = ? ORDER BY x.id",
  ];
  const rows = queries.every(
    (q) => column(a, q, s.projectId).join("|") === column(b, q, s.projectId).join("|"),
  );
  const noteA = readNoteText(a.inst.home, s.disk);
  return (
    rows &&
    column(b, queries[0] ?? "", s.projectId).length >= 2 &&
    noteA === readNoteText(b.inst.home, s.disk)
  );
}

export const userOf = (side: Side): string =>
  (side.inst.db.query<{ id: string }, []>("SELECT id FROM users LIMIT 1").get() as { id: string })
    .id;
