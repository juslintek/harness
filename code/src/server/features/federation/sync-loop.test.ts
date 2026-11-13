import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { until } from "../../test-support/app-kit";
import { createTask } from "../board/api";
import { createNote, projectSlugs, resolveNotePath, type Viewer } from "../memory/api";
import { addAgentMember } from "../orgs/api";
import { startFederation } from "./api";
import { pullPeer } from "./pull";
import {
  bootNode,
  type Node,
  pairNodes,
  peerOn,
  pull,
  rowsOf,
  type Seed,
  seedProject,
  shareTo,
} from "./sync-kit";

let a: Node;
let b: Node;
let seed: Seed;
const feedBodies: string[] = [];
let fetchCalls = 0;
const real = globalThis.fetch;
const spy = spyOn(globalThis, "fetch");

const cursorOf = (node: Node, peer: Node): string | undefined =>
  node.db
    .query<{ value: string }, [string]>("SELECT value FROM fed_state WHERE key = ?")
    .get(`cursor:${peer.instanceId}`)?.value;

beforeAll(async () => {
  [a, b] = await Promise.all([bootNode(), bootNode()]);
  await pairNodes(a, b);
  seed = seedProject(a);
  const counting = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const res = await real(...args);
    if (String(args[0]).includes("/federation/changes")) {
      fetchCalls += 1;
      feedBodies.push(await res.clone().text());
    }
    return res;
  };
  spy.mockImplementation(Object.assign(counting, { preconnect: real.preconnect }));
});

afterAll(() => {
  spy.mockRestore();
  a.stop();
  b.stop();
});

test("the feed body carries no agent, user, secret or repo data", async () => {
  const agent = addAgentMember(a.db, seed.orgId, {
    agentId: "agent-secret-1",
    model: "model-secret",
    handle: "bot",
    displayName: "Bot",
    specialties: [],
  });
  a.db.run("UPDATE projects SET repo = '/secret/repo/path' WHERE id = ?", [seed.projectId]);
  createTask(a.db, {
    projectId: seed.projectId,
    title: "t",
    createdBy: seed.memberId,
    assigneeId: agent.id,
  });
  await shareTo(a, seed, b, "write");
  await pull(b, a);
  const wire = feedBodies.join("\n");
  expect(wire).toContain(agent.id);
  for (const secret of ["agent-secret-1", "model-secret", "/secret/repo/path", a.admin.userId]) {
    expect(wire).not.toContain(secret);
  }
  for (const key of ["agent_id", "user_id", "model", "repo", "specialties"]) {
    expect(wire).not.toContain(`"${key}"`);
  }
  expect(JSON.stringify(rowsOf(b.db, "members"))).not.toContain("secret");
});

test("the cursor stays put when applying a page fails and moves once it succeeds", async () => {
  createTask(a.db, { projectId: seed.projectId, title: "later", createdBy: seed.memberId });
  const before = cursorOf(b, a);
  const tasks = rowsOf(b.db, "tasks").length;
  const failing = {
    read: () => null,
    write: () => true,
    remove: () => {},
  };
  const viewer: Viewer = {
    orgId: seed.orgId,
    memberId: null,
    projectIds: [seed.projectId],
    canWriteGlobal: false,
    canWrite: true,
    actor: "ann",
  };
  const loc = resolveNotePath("/memories/project/ENG/x.md", viewer, projectSlugs(a.db, seed.orgId));
  if (loc === null || loc === "dir") throw new Error("bad path");
  await createNote(a.db, a.home, { viewer, runId: null }, loc, "body");
  const boom = {
    ...failing,
    write: (): boolean => {
      throw new Error("disk full");
    },
  };
  await expect(pullPeer(b.db, b.home, peerOn(b, a), { bodies: boom })).rejects.toThrow("disk full");
  expect(cursorOf(b, a)).toBe(before);
  expect(rowsOf(b.db, "tasks")).toHaveLength(tasks);
  await pullPeer(b.db, b.home, peerOn(b, a), { bodies: failing });
  expect(Number(cursorOf(b, a))).toBeGreaterThan(Number(before));
  expect(rowsOf(b.db, "tasks")).toHaveLength(tasks + 1);
});

test("a peer cannot steer the cursor past what it actually sent", async () => {
  const before = cursorOf(b, a);
  spy.mockImplementationOnce(
    Object.assign(async () => Response.json({ changes: [], next: 999_999 }), {
      preconnect: real.preconnect,
    }),
  );
  await pullPeer(b.db, b.home, peerOn(b, a));
  expect(cursorOf(b, a)).toBe(before);
});

test("the loop pulls on its own and stops cleanly", async () => {
  const stop = startFederation(b.db, { home: b.home, pullIntervalMs: 20 });
  createTask(a.db, { projectId: seed.projectId, title: "by loop", createdBy: seed.memberId });
  await until(() => rowsOf(b.db, "tasks").some((t) => t.title === "by loop"));
  await stop();
  const calls = fetchCalls;
  await new Promise((r) => setTimeout(r, 120));
  expect(fetchCalls).toBe(calls);
});
