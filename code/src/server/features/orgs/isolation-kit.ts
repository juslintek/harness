import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ApiKit, bootApi } from "../../test-support/api-kit";
import { drainCommits } from "../memory/api";
import { addAgentMember } from "../orgs/api";
import { SECRET, type SeedScope, seedHire } from "./isolation-seed";

export { SECRET };

export type Ids = Record<string, string>;
interface NoteRef {
  id: string;
  hash: string;
}
type Who = Awaited<ReturnType<ApiKit["user"]>>;

export interface Fixture {
  kit: ApiKit;
  home: string;
  // `a` owns org alpha (and is instance admin so agent routes can succeed); `b` owns org bravo.
  a: Who;
  b: Who;
  scope: SeedScope;
  ids: Ids;
}

// A request the control and the attack both run, so anything it consumes needs a fresh row each time.
export interface Case {
  name: string;
  method: string;
  path: (ids: Ids) => string;
  body?: (ids: Ids) => unknown;
  fresh?: (f: Fixture) => Ids | Promise<Ids>;
  // Statuses the org A control may return. Default: any 2xx.
  accepts?: readonly number[];
  // The org B request goes here when it differs: org A's id named under org B's own slug.
  attackPath?: (ids: Ids) => string;
}

const homes: string[] = [];

export async function post<T = { id: string }>(
  f: Pick<Fixture, "kit" | "a">,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await f.kit.call(f.a, "POST", path, body);
  expect(res.status, `seed ${path}`).toBeLessThan(300);
  return (await res.json()) as T;
}

function one(db: Database, sql: string, ...args: string[]): string {
  return (db.query<{ id: string }, string[]>(sql).get(...args) as { id: string }).id;
}

async function seedWork(f: Omit<Fixture, "ids">): Promise<Ids> {
  const { kit, scope } = f;
  const team = await post(f, "/api/orgs/alpha/teams", { name: "Hiring" });
  const project = await post(f, "/api/orgs/alpha/projects", { key: "AA", name: SECRET });
  const task = await post(f, `/api/projects/${project.id}/tasks`, { title: SECRET });
  const group = await post(f, "/api/orgs/alpha/groups", { name: SECRET, memberIds: [] });
  const carol = await kit.user();
  const peer = kit.join(scope.orgId, carol, "member", "carol");
  const agent = addAgentMember(kit.db, scope.orgId, {
    agentId: "x",
    handle: "bot",
    displayName: "bot",
    specialties: [],
  });
  const position = await post(f, "/api/orgs/alpha/positions", { title: SECRET });
  const org = (sql: string): string => one(kit.db, sql, scope.orgId);
  return {
    team: team.id,
    project: project.id,
    task: task.id,
    group: group.id,
    peer: peer.id,
    agent: agent.id,
    position: position.id,
    channel: scope.channelId,
    member: scope.memberId,
    projectChannel: org("SELECT id FROM channels WHERE org_id = ? AND kind = 'project'"),
  };
}

export async function makeNote(
  f: Pick<Fixture, "kit" | "a">,
  body: string,
  rel?: string,
): Promise<NoteRef> {
  const written = await post<{ note: NoteRef }>(f, "/api/orgs/alpha/memory/notes", {
    scope: "org",
    rel: rel ?? `seed-${Bun.randomUUIDv7()}.md`,
    body,
  });
  return written.note;
}

// The seed note links to a second one, so link resolution and backlinks have something to find.
async function seedNote(f: Omit<Fixture, "ids">): Promise<Ids> {
  const target = await makeNote(f, `${SECRET} target`, "elsewhere.md");
  const note = await makeNote(f, `${SECRET} links to [[elsewhere]]`);
  return {
    note: note.id,
    noteHash: note.hash,
    target: target.id,
  };
}

async function setup(): Promise<Fixture> {
  // A closed port keeps note classification off a real Laya.
  process.env.OLLAYA_URL = "http://127.0.0.1:1";
  const home = mkdtempSync(join(tmpdir(), "harness-isolation-"));
  homes.push(home);
  const kit = bootApi(home);
  // Step-up is on so a 403 can only come from the tenant check, not from a missing step-up.
  const a = await kit.user({ stepUp: true, admin: true });
  const b = await kit.user({ stepUp: true });
  const orgA = kit.org(a, "alpha");
  const orgB = kit.org(b, "bravo");
  const channelId = one(
    kit.db,
    "SELECT id FROM channels WHERE org_id = ? AND kind = 'org'",
    orgA.id,
  );
  const scope: SeedScope = {
    orgId: orgA.id,
    teamId: "",
    memberId: orgA.owner.id,
    channelId,
  };
  const base = { kit, home, a, b, scope };
  const work = await seedWork(base);
  scope.teamId = work.team as string;
  const hire = seedHire(kit.db, scope);
  return {
    ...base,
    ids: { ...work, ...(await seedNote(base)), ...hire, orgA: orgA.id, orgB: orgB.id },
  };
}

async function send(f: Fixture, who: Who, c: Case, attack: boolean): Promise<Response> {
  const ids = { ...f.ids, ...(c.fresh ? await c.fresh(f) : {}) };
  const path = attack && c.attackPath ? c.attackPath(ids) : c.path(ids);
  return f.kit.call(who, c.method, path, c.body?.(ids));
}

// The control proves the target exists and org A's own admin may use it; only then does the
// refusal for org B mean the tenant check ran instead of the row being missing.
async function verify(f: Fixture, c: Case): Promise<void> {
  const own = await send(f, f.a, c, false);
  const ownText = await own.text();
  const accepted = c.accepts ?? [200, 201, 202];
  expect(accepted, `${c.name} control -> ${own.status} ${ownText.slice(0, 160)}`).toContain(
    own.status,
  );
  const other = await send(f, f.b, c, true);
  const text = await other.text();
  expect([403, 404], `${c.name} as org B -> ${other.status} ${text.slice(0, 160)}`).toContain(
    other.status,
  );
  expect(text, `${c.name} leaked org A data`).not.toContain(SECRET);
}

// One fixture per file, one test per case, so a failure names the route.
export function defineCases(title: string, cases: readonly Case[]): void {
  let fixture: Promise<Fixture> | undefined;
  afterAll(async () => {
    delete process.env.OLLAYA_URL;
    await drainCommits();
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });
  describe(title, () => {
    for (const c of cases) {
      test(c.name, async () => {
        fixture ??= setup();
        await verify(await fixture, c);
      });
    }
  });
}
