import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTask } from "../board/api";
import { createProject } from "../orgs/api";
import type { BatchResult, Change } from "./apply";
import { permitInbound } from "./inbound";
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

// a is the home. b holds no grant on seed's project P, but may write the project G and has a stub
// org (and the member BEE in it) here. Everything below is a page b sends to a.
let a: Node;
let b: Node;
let seed: Seed;
let granted: string;
let readOnly: string;
let grantedTask: string;
let stubOrg: string;
let homeTask: string;
let homeChannel: string;

const BEE = "m-bee";
const HOME_ROOT = "m-home-root";

const { put, run, stored } = plantedKit(
  () => a,
  () => b,
);

const copy = (id: string, org: string = stubOrg): Change =>
  put("projects", id, id, {
    id,
    org_id: org,
    key: id,
    name: id,
    home_instance: b.instanceId,
    created_at: 1,
  });
const task = (id: string, project: string, org: string = stubOrg): Change =>
  put("tasks", id, project, { ...taskRow(id, project, org), created_by: BEE });
const channel = (id: string, project: string, org: string = stubOrg): Change =>
  put("channels", id, project, {
    id,
    org_id: org,
    kind: "project",
    name: id,
    project_id: project,
    created_at: 1,
  });
const comment = (id: string, project: string, taskId: string, author: string): Change =>
  put("comments", id, project, {
    id,
    task_id: taskId,
    author_id: author,
    body: "forged",
    created_at: 1,
  });
const message = (
  id: string,
  project: string,
  channelId: string,
  root: string | null,
  author: string,
): Change =>
  put("messages", id, project, {
    id,
    channel_id: channelId,
    thread_root_id: root,
    author_id: author,
    body: "forged",
    created_at: 1,
    edited_at: null,
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

const projectOf = (table: string, id: string): string | undefined =>
  a.db.query<{ p: string }, [string]>(`SELECT project_id AS p FROM ${table} WHERE id = ?`).get(id)
    ?.p;
beforeAll(async () => {
  [a, b] = await Promise.all([bootNode(), bootNode()]);
  await pairNodes(a, b);
  seed = seedProject(a);
  granted = createProject(a.db, { orgId: seed.orgId, key: "GRT", name: "Granted" }).id;
  await shareTo(a, { ...seed, projectId: granted }, b, "write");
  readOnly = createProject(a.db, { orgId: seed.orgId, key: "RDO", name: "Read only" }).id;
  await shareTo(a, { ...seed, projectId: readOnly }, b, "read");
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
  homeChannel =
    a.db
      .query<{ id: string }, [string]>("SELECT id FROM channels WHERE project_id = ?")
      .get(seed.projectId)?.id ?? "";
  a.db.run(
    "INSERT INTO messages (id, channel_id, author_id, body, created_at) VALUES (?, ?, ?, 'x', 1)",
    [HOME_ROOT, homeChannel, seed.memberId],
  );
});

afterAll(() => {
  a.stop();
  b.stop();
});

test("a comment is not planted on a home task through a copy project and a page-only task row", () => {
  const out = run(
    copy("q-comment"),
    task(homeTask, "q-comment"),
    comment("c-planted", "q-comment", homeTask, seed.memberId),
  );
  expect(out).toEqual({ allowed: ["projects:q-comment"], result: applied(1) });
  expect(stored("comments", "c-planted")).toBe(0);
  expect(projectOf("tasks", homeTask)).toBe(seed.projectId);
});

test("a message is not planted in a home channel through a copy project and a page-only channel row", () => {
  const out = run(
    copy("q-message"),
    channel(homeChannel, "q-message"),
    message("m-planted", "q-message", homeChannel, null, seed.memberId),
    message("m-planted-reply", "q-message", homeChannel, HOME_ROOT, seed.memberId),
  );
  expect(out).toEqual({ allowed: ["projects:q-message"], result: applied(1) });
  expect(stored("messages", "m-planted") + stored("messages", "m-planted-reply")).toBe(0);
  expect(projectOf("channels", homeChannel)).toBe(seed.projectId);
});

test("a project row that is itself refused does not vouch for the rows that name it", () => {
  const q = "q-refused";
  // It names a local org, so it is not the peer's copy and nothing under it may pass.
  const out = run(
    copy(q, seed.orgId),
    task("t-refused", q, seed.orgId),
    comment("c-refused", q, "t-refused", seed.memberId),
    channel("ch-refused", q, seed.orgId),
    message("m-refused", q, "ch-refused", null, seed.memberId),
    task(homeTask, q, seed.orgId),
    comment("c-refused-home", q, homeTask, seed.memberId),
  );
  expect(out).toEqual({ allowed: [], result: applied(0) });
  expect(stored("comments", "c-refused-home") + stored("tasks", "t-refused")).toBe(0);
  expect(stored("projects", q)).toBe(0);
});

test("a member row refused for its label is not stored, so a comment by it is rejected by apply", () => {
  const ghost = (project: string): Change[] => [
    member("m-ghost", project),
    comment("c-ghost", granted, grantedTask, "m-ghost"),
  ];
  const rejected: BatchResult = { applied: 0, stale: 0, rejected: 1 };
  // In a copy project the stub org is refused as a member org, since it holds a grant here.
  expect(run(copy("q-ghost"), ...ghost("q-ghost"))).toEqual({
    allowed: ["projects:q-ghost", "comments:c-ghost"],
    result: { ...rejected, applied: 1 },
  });
  // And the project P is not one the peer may write at all.
  expect(run(...ghost(seed.projectId))).toEqual({
    allowed: ["comments:c-ghost"],
    result: rejected,
  });
  expect(stored("members", "m-ghost") + stored("comments", "c-ghost")).toBe(0);
});

test("a write peer's new task keeps its creator when the creator's member row is refused for its label", () => {
  // Member changes go out once per shared project; the one labelled with a read grant is refused, and
  // the creator is a member of the peer's own stub org whatever label the row carries.
  const byCreator = (id: string, creator: string): Change =>
    put("tasks", id, granted, { ...taskRow(id, granted, seed.orgId), created_by: creator });
  const late = [member("m-late", readOnly), byCreator("t-late", "m-late")];
  expect(run(...late)).toEqual({ allowed: ["tasks:t-late"], result: applied(1) });
  const early = [byCreator("t-early", "m-early"), member("m-early", readOnly)];
  expect(run(...early)).toEqual({ allowed: ["tasks:t-early"], result: applied(1) });
  expect(stored("tasks", "t-late") + stored("tasks", "t-early")).toBe(2);
  expect(stored("members", "m-late") + stored("members", "m-early")).toBe(0);
});

test("a copy page is accepted in full whatever order it is sent in", () => {
  const page = [
    copy("q-ok"),
    channel("ch-ok", "q-ok"),
    task("t-ok", "q-ok"),
    comment("c-ok", "q-ok", "t-ok", BEE),
    message("m-ok", "q-ok", "ch-ok", null, BEE),
  ];
  for (const order of permutations(page)) {
    expect(ids(permitInbound(a.db, b.instanceId, order).allowed)).toEqual(ids(order));
  }
  const reversed = [...page].reverse();
  expect(run(...reversed)).toEqual({ allowed: ids(reversed), result: applied(5) });
  expect(a.db.query("SELECT task_id FROM comments WHERE id = 'c-ok'").get()).toEqual({
    task_id: "t-ok",
  });
  expect(a.db.query("SELECT channel_id FROM messages WHERE id = 'm-ok'").get()).toEqual({
    channel_id: "ch-ok",
  });
});

test("a write peer's comment on a granted project still goes through, also ahead of its task", () => {
  expect(run(comment("c-g1", granted, grantedTask, BEE))).toEqual({
    allowed: ["comments:c-g1"],
    result: applied(1),
  });
  const fresh = [comment("c-g2", granted, "t-g2", BEE), task("t-g2", granted, seed.orgId)];
  expect(run(...fresh)).toEqual({ allowed: ids(fresh), result: applied(2) });
  expect(stored("comments", "c-g1") + stored("comments", "c-g2")).toBe(2);
});

test("a comment sent ahead of its task cannot take the mode of another project by its label", () => {
  // The task lands in G, where a home author is refused; the label says copy project, where it is not.
  const out = run(
    copy("q-borrow"),
    comment("c-borrow", "q-borrow", "t-borrow", seed.memberId),
    task("t-borrow", granted, seed.orgId),
  );
  expect(out).toEqual({ allowed: ["projects:q-borrow", "tasks:t-borrow"], result: applied(2) });
  expect(stored("comments", "c-borrow")).toBe(0);
});
