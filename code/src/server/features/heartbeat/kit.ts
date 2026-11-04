import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { fakeAgents } from "../../test-support/agents-kit";
import type { AgentSpec } from "../agents/api";
import { createTask } from "../board/api";
import type { ChannelView } from "../chat/api";
import { ensureTeamChannel, wireChat } from "../chat/api";
import { verifyRunToken } from "../mcp/api";
import { addAgentMember, createOrg, createProject, listTeams, type MemberRow } from "../orgs/api";
import type { RunDeps } from "../runtimes/api";

type RunOutcome = Awaited<ReturnType<NonNullable<RunDeps["lane"]>>>;

import { type HeartbeatDeps, startHeartbeat } from "./api";

const spec: AgentSpec = {
  id: "fake",
  name: "Fake",
  lane: "acp",
  bin: process.execPath,
  args: [],
  versionArgs: [],
  loginProbe: null,
  loginArgs: null,
  modeOption: null,
  egress: [],
  stateWrite: [],
  weakerNetworkIsolation: false,
  claudeMeta: false,
};

export const specFor = (id: string): AgentSpec => ({ ...spec, id });

const done: RunOutcome = {
  stopReason: "end_turn",
  text: "",
  usage: [],
  error: null,
  sessionId: null,
};

// Route discovery would spawn every installed agent CLI; the fake agent is the only engine here.
export const routeDeps: NonNullable<HeartbeatDeps["routeDeps"]> = fakeAgents(
  "fake",
  "fake2",
  "fake3",
  "claude",
  "codex",
);

interface Seen {
  memberId: string | null;
  scopes: string[];
  prompt: string;
}

export interface Kit {
  db: Database;
  home: string;
  orgId: string;
  human: { id: string };
  projectId: string;
  teamChannel: ChannelView;
  runDeps: RunDeps;
  seen: Seen[];
  // While set, every run waits for it, so a test decides when runs end.
  hold: { gate: Promise<void> | null; release: () => void };
  agent: (handle: string, specialties?: string[], agentId?: string) => MemberRow;
  task: (title: string) => ReturnType<typeof createTask>;
  start: (extra?: Partial<HeartbeatDeps>) => () => Promise<void>;
}

export function setup(): Kit {
  const home = mkdtempSync(join(tmpdir(), "heartbeat-"));
  const db = openDb(":memory:");
  migrate(db, migrations);
  wireChat(db);
  const org = createOrg(db, {
    name: "Acme",
    slug: "acme",
    ownerUserId: "u1",
    ownerName: "Owner",
    ownerHandle: "owner",
  });
  const human = db
    .query<{ id: string }, [string]>("SELECT id FROM members WHERE org_id = ?")
    .get(org.id) as { id: string };
  const project = createProject(db, { orgId: org.id, key: "web", name: "Web" });
  const team = listTeams(db, org.id)[0] as { id: string };
  const seen: Seen[] = [];
  const hold: Kit["hold"] = { gate: null, release: () => {} };
  const lane = async (ctx: {
    mcp: { token: string } | null;
    prompt: string;
  }): Promise<RunOutcome> => {
    const id = ctx.mcp ? verifyRunToken(db, ctx.mcp.token) : null;
    seen.push({ memberId: id?.memberId ?? null, scopes: id?.scopes ?? [], prompt: ctx.prompt });
    await hold.gate;
    return done;
  };
  const runDeps: RunDeps = { home, port: 1, resolveSpec: () => spec, lane };
  return {
    db,
    home,
    orgId: org.id,
    human,
    projectId: project.id,
    teamChannel: ensureTeamChannel(db, team.id),
    runDeps,
    seen,
    hold,
    agent: (handle, specialties = [], agentId = "fake") =>
      addAgentMember(db, org.id, { agentId, handle, displayName: handle, specialties }),
    task: (title) => createTask(db, { projectId: project.id, title, createdBy: human.id }),
    start: (extra = {}) => startHeartbeat(db, { runDeps, home, tickMs: 20, routeDeps, ...extra }),
  };
}

export function holdRuns(kit: Kit): void {
  kit.hold.gate = new Promise<void>((resolve) => {
    kit.hold.release = () => {
      kit.hold.gate = null;
      resolve();
    };
  });
}

export async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error("condition not met in time");
}

export function wakes(db: Database, memberId: string): Record<string, string | null>[] {
  return db
    .query<Record<string, string | null>, [string]>(
      "SELECT reason, status, run_id, caused_by, detail FROM wakeups WHERE member_id = ? ORDER BY created_at, id",
    )
    .all(memberId);
}
