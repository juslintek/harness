import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTask } from "../board/api";
import { ensureProjectChannel } from "../chat/api";
import { createProject } from "../orgs/api";
import type { Change } from "./apply";
import {
  addPeerMember,
  applied,
  bootNode,
  ids,
  type Node,
  pairNodes,
  permutations,
  plantedKit,
  type Seed,
  seedProject,
  shareTo,
  taskRow,
} from "./sync-kit";

// Rules of permitInbound that each guard one line of inbound.ts or inbound-refs.ts. a is the home,
// b may write the project G and has a stub org (and the member BEE in it) here.
let a: Node;
let b: Node;
let seed: Seed;
let granted: string;
let grantedTask: string;
let grantedChannel: string;
let homeTask: string;
let stubOrg: string;

const BEE = "m-bee";

const { put, run, stored } = plantedKit(
  () => a,
  () => b,
);

const copy = (id: string): Change =>
  put("projects", id, id, {
    id,
    org_id: stubOrg,
    key: id,
    name: id,
    home_instance: b.instanceId,
    created_at: 1,
  });
const task = (id: string, project: string, org: string = stubOrg): Change =>
  put("tasks", id, project, { ...taskRow(id, project, org), created_by: BEE });
const channel = (id: string, project: string): Change =>
  put("channels", id, project, {
    id,
    org_id: stubOrg,
    kind: "project",
    name: id,
    project_id: project,
    created_at: 1,
  });
const dep = (project: string, from: string, to: string): Change =>
  put("task_deps", `${from}:${to}`, project, { task_id: from, depends_on: to, created_at: 1 });
const comment = (id: string, project: string, taskId: string, author: string): Change =>
  put("comments", id, project, {
    id,
    task_id: taskId,
    author_id: author,
    body: "forged",
    created_at: 1,
  });
const message = (id: string, project: string, channelId: string, author: string = BEE): Change =>
  put("messages", id, project, {
    id,
    channel_id: channelId,
    thread_root_id: null,
    author_id: author,
    body: "forged",
    created_at: 1,
    edited_at: null,
  });
const del = (table: string, id: string, project: string): Change => ({
  ...put(table, id, project, {}),
  op: "del",
  data: null,
});
const at = (change: Change, ms: number): Change => ({
  ...change,
  hlc: `${String(ms).padStart(13, "0")}-0000-${b.instanceId}`,
});
const member = (id: string, project: string): Change =>
  put("members", id, project, {
    id,
    org_id: stubOrg,
    kind: "human",
    handle: id,
    display_name: id,
    role: "member",
  });

// The four ways two twins can arrive: either one newer, and either one first.
function twinPages(twins: (n: number) => [Change, Change]): Change[][] {
  return [0, 1, 2, 3].map((n) => {
    const [inGranted, inCopy] = twins(n);
    const stamped = n & 1 ? [at(inGranted, 2), at(inCopy, 1)] : [at(inGranted, 1), at(inCopy, 2)];
    return n & 2 ? stamped.reverse() : stamped;
  });
}

// Stored comments or messages that sit in G under a home author, which a write peer may never plant.
const homeVoiceInGranted = (child: string, parent: string, link: string): number =>
  a.db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM ${child} c JOIN ${parent} p ON p.id = c.${link}
       WHERE p.project_id = ? AND c.author_id = ?`,
    )
    .get(granted, seed.memberId)?.n ?? 0;

beforeAll(async () => {
  [a, b] = await Promise.all([bootNode(), bootNode()]);
  await pairNodes(a, b);
  seed = seedProject(a);
  granted = createProject(a.db, { orgId: seed.orgId, key: "GRT", name: "Granted" }).id;
  await shareTo(a, { ...seed, projectId: granted }, b, "write");
  stubOrg =
    a.db
      .query<{ id: string }, [string]>("SELECT id FROM orgs WHERE home_instance = ?")
      .get(b.instanceId)?.id ?? "";
  addPeerMember(a, b, BEE);
  homeTask = createTask(a.db, {
    projectId: seed.projectId,
    title: "home",
    createdBy: seed.memberId,
  }).id;
  grantedTask = createTask(a.db, { projectId: granted, title: "granted", createdBy: BEE }).id;
  grantedChannel = ensureProjectChannel(a.db, granted).id;
});

afterAll(() => {
  a.stop();
  b.stop();
});

test("a dependency cannot tie a granted task to a home task, in either direction", () => {
  expect(run(dep(granted, grantedTask, homeTask))).toEqual({ allowed: [], result: applied(0) });
  expect(run(dep(granted, homeTask, grantedTask))).toEqual({ allowed: [], result: applied(0) });
  expect(a.db.query("SELECT COUNT(*) AS n FROM task_deps").get()).toEqual({ n: 0 });
});

test("a message sent ahead of its channel cannot take the mode of another project by its label", () => {
  const out = run(
    copy("q-m1"),
    copy("q-m2"),
    message("m-mis", "q-m1", "ch-mis"),
    channel("ch-mis", "q-m2"),
  );
  expect(out).toEqual({
    allowed: ["projects:q-m1", "projects:q-m2", "channels:ch-mis"],
    result: applied(3),
  });
  expect(stored("messages", "m-mis")).toBe(0);
});

test("a dependency sent ahead of its tasks is judged by their project, not by its label", () => {
  const out = run(
    copy("q-d1"),
    dep("q-d1", "t-d1", "t-d2"),
    task("t-d1", granted, seed.orgId),
    task("t-d2", granted, seed.orgId),
  );
  expect(out).toEqual({
    allowed: ["projects:q-d1", "tasks:t-d1", "tasks:t-d2"],
    result: applied(3),
  });
  expect(a.db.query("SELECT COUNT(*) AS n FROM task_deps WHERE task_id = 't-d1'").get()).toEqual({
    n: 0,
  });
});

test("a dependency sent ahead of its copy-project tasks is accepted in any order", () => {
  permutations([0, 1, 2, 3]).forEach((positions, n) => {
    const project = `q-ok${n}`;
    const page = [
      copy(project),
      dep(project, `t-a${n}`, `t-b${n}`),
      task(`t-a${n}`, project),
      task(`t-b${n}`, project),
    ];
    const order = positions.map((i) => page[i] as Change);
    expect(run(...order)).toEqual({ allowed: ids(order), result: applied(4) });
    expect(
      a.db
        .query("SELECT 1 FROM task_deps WHERE task_id = ? AND depends_on = ?")
        .get(`t-a${n}`, `t-b${n}`),
    ).not.toBeNull();
  });
});

test("a refused edit of a stored task does not hold back a comment on it", () => {
  const forged = put("tasks", grantedTask, granted, {
    ...taskRow(grantedTask, granted, seed.orgId),
    created_by: seed.memberId,
  });
  const out = run(forged, comment("c-keep", granted, grantedTask, BEE));
  expect(out).toEqual({ allowed: ["comments:c-keep"], result: applied(1) });
  expect(stored("comments", "c-keep")).toBe(1);
});

test("a new member row that passes vouches for its comment in the same page, in either order", () => {
  for (const id of ["m-new1", "m-new2"]) {
    const page = [member(id, granted), comment(`c-${id}`, granted, grantedTask, id)];
    const order = id === "m-new1" ? page : [...page].reverse();
    expect(run(...order)).toEqual({ allowed: ids(order), result: applied(2) });
    expect(stored("comments", `c-${id}`)).toBe(1);
  }
});

test("a member row refused for its org does not make a stored home member the peer's", () => {
  // A refused row labels members that are not stored here, but must never outvote one that is.
  const relabel = member(seed.memberId, granted);
  const page = [relabel, comment("c-imp0", granted, grantedTask, seed.memberId)];
  const other = [comment("c-imp1", granted, grantedTask, seed.memberId), relabel];
  for (const order of [page, other]) {
    expect(run(...order)).toEqual({ allowed: [], result: applied(0) });
  }
  expect(stored("comments", "c-imp0") + stored("comments", "c-imp1")).toBe(0);
});

test("a channel sent in two copy projects is evidence for no message", () => {
  permutations([0, 1, 2, 3, 4]).forEach((positions, n) => {
    const page = [
      copy(`q-a${n}`),
      copy(`q-b${n}`),
      channel(`ch${n}`, `q-a${n}`),
      channel(`ch${n}`, `q-b${n}`),
      message(`ms${n}`, `q-a${n}`, `ch${n}`),
    ];
    const order = positions.map((i) => page[i] as Change);
    expect(run(...order).allowed).toEqual(ids(order.filter((c) => c.table_name !== "messages")));
    expect(stored("messages", `ms${n}`)).toBe(0);
  });
});

test("comment twins in a granted and a copy task never leave a home author on the granted one", () => {
  expect(run(copy("q-twa"), task("t-twa", "q-twa")).result).toEqual(applied(2));
  const pages = twinPages((n) => [
    comment(`c-twa${n}`, granted, grantedTask, BEE),
    comment(`c-twa${n}`, "q-twa", "t-twa", seed.memberId),
  ]);
  for (const page of pages) run(...page);
  expect(homeVoiceInGranted("comments", "tasks", "task_id")).toBe(0);
});

test("message twins in a granted and a copy channel never leave a home author on the granted one", () => {
  expect(run(copy("q-twb"), channel("ch-twb", "q-twb")).result).toEqual(applied(2));
  const pages = twinPages((n) => [
    message(`m-twb${n}`, granted, grantedChannel),
    message(`m-twb${n}`, "q-twb", "ch-twb", seed.memberId),
  ]);
  for (const page of pages) run(...page);
  expect(homeVoiceInGranted("messages", "channels", "channel_id")).toBe(0);
});

test("a task put in G and deleted under a copy label cannot carry a home comment", () => {
  expect(run(copy("q-del")).result).toEqual(applied(1));
  permutations([0, 1, 2]).forEach((positions, n) => {
    const page = [
      task(`t-del${n}`, granted, seed.orgId),
      del("tasks", `t-del${n}`, "q-del"),
      comment(`c-del${n}`, "q-del", `t-del${n}`, seed.memberId),
    ];
    const order = positions.map((i) => page[i] as Change);
    expect(run(...order).allowed).not.toContain(`comments:c-del${n}`);
    expect(stored("comments", `c-del${n}`)).toBe(0);
  });
});
