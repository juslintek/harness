// Scenario setup, timeline and reads for the Phase 4 gate: org gate4, @lead and @dev on Claude,
// @dev2 on Codex, and a scratch repo with a src/ directory.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureInstance, migrate, openDb } from "../src/server/db/db";
import { migrations } from "../src/server/db/migrations";
import { listAgents, setLinked } from "../src/server/features/agents/api";
import { createUser } from "../src/server/features/auth/api";
import { onTaskChange, wireBoard } from "../src/server/features/board/api";
import { ensureProjectChannel, onMessage, wireChat } from "../src/server/features/chat/api";
import {
  addAgentMember,
  addToTeam,
  createOrg,
  createPosition,
  createProject,
  listTeams,
  type MemberRow,
} from "../src/server/features/orgs/api";
import { onRunEvent, wireRuntimes } from "../src/server/features/runtimes/api";
import { createApp } from "../src/server/http";
import { git } from "./gate-2-kit";
import { gateAgentIds, leadAgentId } from "./gate-engine";

export type Db = ReturnType<typeof openDb>;

export interface Scene {
  orgId: string;
  projectId: string;
  repo: string;
  owner: string;
  lead: MemberRow;
  dev: MemberRow;
  dev2: MemberRow;
}

export const failures: string[] = [];
export const results: string[] = [];
export const timeline: { secs: number; what: string }[] = [];
const t0 = Date.now();

export function mark(what: string): void {
  const secs = Math.round((Date.now() - t0) / 1000);
  timeline.push({ secs, what });
  console.log(`${String(secs).padStart(4, " ")}s  ${what}`);
}

export function check(ok: boolean, what: string): void {
  if (!ok) failures.push(what);
  results.push(`${ok ? "PASS" : "FAIL"}  ${what}`);
  console.log(results.at(-1));
}

async function requireLogin(db: Db): Promise<void> {
  const agents = await listAgents(db);
  for (const id of gateAgentIds()) {
    const a = agents.find((x) => x.id === id);
    if (!a?.installed || a.loggedIn !== true) {
      console.error(`FATAL: ${id} is not installed or not logged in (${JSON.stringify(a)})`);
      process.exit(1);
    }
  }
}

export async function boot(root: string): Promise<{
  db: Db;
  home: string;
  port: number;
  stop: () => Promise<void>;
}> {
  const home = join(root, "home");
  mkdirSync(home);
  const db = openDb(join(home, "harness.db"));
  migrate(db, migrations);
  const instanceId = ensureInstance(db);
  await requireLogin(db);
  wireBoard(db);
  wireChat(db);
  wireRuntimes();
  const handler: { fetch: (r: Request) => Response | Promise<Response> } = {
    fetch: () => new Response("booting", { status: 503 }),
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => handler.fetch(r) });
  const port = server.port ?? 0;
  const rp = { id: "localhost", name: "Harness", origin: `http://localhost:${port}` };
  handler.fetch = createApp({ db, home, port, rp, instanceId, version: "gate4" }).fetch;
  console.log(`home ${home} (kept for inspection), port ${port}`);
  return { db, home, port, stop: async () => void (await server.stop(true)) };
}

function scratchRepo(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, "README.md"), "# gate4\n\nSmall JavaScript helpers.\n");
  writeFileSync(join(repo, "package.json"), '{"name":"g4","private":true,"type":"module"}\n');
  writeFileSync(join(repo, "src", ".gitkeep"), "");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);
  return repo;
}

function members(db: Db, orgId: string, claudeModel: string | null): MemberRow[] {
  // The router only runs agents a person has linked, as the one-click link in the UI would.
  for (const id of gateAgentIds()) setLinked(db, id, true);
  const model = claudeModel === null ? {} : { model: claudeModel };
  const add = (agentId: string, handle: string, extra: object): MemberRow =>
    addAgentMember(db, orgId, {
      agentId,
      handle,
      displayName: handle,
      specialties: [],
      ...extra,
    });
  return [
    add(leadAgentId(), "lead", model),
    add(leadAgentId(), "dev", model),
    add("codex", "dev2", {}),
  ];
}

export function build(db: Db, root: string, claudeModel: string | null): Scene {
  const repo = scratchRepo(root);
  const userId = createUser(db, { email: "gate4@test.local", name: "Gate", instanceAdmin: true });
  const org = createOrg(db, {
    name: "Gate 4",
    slug: "gate4",
    ownerUserId: userId,
    ownerName: "Gate",
    ownerHandle: "gate",
  });
  const core = listTeams(db, org.id).find((t) => t.name === "Core");
  if (!core) throw new Error("no Core team");
  const [lead, dev, dev2] = members(db, org.id, claudeModel) as [MemberRow, MemberRow, MemberRow];
  for (const m of [lead, dev, dev2]) addToTeam(db, core.id, m.id);
  const pos = { orgId: org.id, teamId: core.id };
  const leadPos = createPosition(db, {
    ...pos,
    title: "Tech lead",
    memberId: lead.id,
    isManager: true,
  });
  for (const m of [dev, dev2]) {
    createPosition(db, { ...pos, title: "Developer", memberId: m.id, reportsTo: leadPos.id });
  }
  const project = createProject(db, { ...pos, key: "gate4", name: "gate4", repo });
  ensureProjectChannel(db, project.id);
  const owner = db
    .query<{ id: string }, [string]>("SELECT id FROM members WHERE user_id = ?")
    .get(userId)?.id;
  if (!owner) throw new Error("no owner member");
  return { orgId: org.id, projectId: project.id, repo, owner, lead, dev, dev2 };
}

export function watchTimeline(db: Db, s: Scene): () => void {
  const handle = (id: string | null): string => {
    const row = db
      .query<{ handle: string }, [string | null]>("SELECT handle FROM members WHERE id = ?")
      .get(id);
    return row ? `@${row.handle}` : "?";
  };
  const offs = [
    onTaskChange((c) =>
      mark(
        `task #${c.task.number} ${c.kind} by ${handle(c.by)} status=${c.task.status} assignee=${handle(c.task.assigneeId)}`,
      ),
    ),
    onMessage((e) => {
      const to = e.mentions.map(handle).join(",");
      const from = e.message.authorId === s.owner ? "gate" : handle(e.message.authorId);
      mark(
        `chat ${from}${to ? ` -> ${to}` : ""}: ${e.message.body.slice(0, 140).replace(/\s+/g, " ")}`,
      );
    }),
    onRunEvent((runId, e) => {
      if (e.kind === "run") mark(`run ${runId.slice(-6)} ${e.body ?? ""}`.trim());
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}

export function writeTimeline(home: string): void {
  writeFileSync(
    join(home, "timeline.json"),
    `${JSON.stringify({ timeline, assertions: results, failures }, null, 2)}\n`,
  );
}
