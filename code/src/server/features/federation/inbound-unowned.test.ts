import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createNote,
  getIndexedByDisk,
  projectSlugs,
  readNoteText,
  resolveNotePath,
  type Viewer,
} from "../memory/api";
import { createProject } from "../orgs/api";
import { applyBatch, type BatchResult, type Change } from "./apply";
import { noteBodies } from "./bodies";
import { permitInbound } from "./inbound";
import {
  addPeerMember,
  applied,
  bootNode,
  ids,
  type Node,
  pairNodes,
  plantedKit,
  type Seed,
  seedProject,
  shareTo,
  taskRow,
} from "./sync-kit";

// a is the home and holds rows that belong to no project: global and org notes, org and dm channels
// and the messages in them. b may write the project G and owns the copy project Q here, so every
// change it sends about those rows carries a label it is allowed to use.
let a: Node;
let b: Node;
let seed: Seed;
let viewer: Viewer;
let granted: string;
let stubOrg: string;

const BEE = "m-bee";
const COPY = "q-own";
const refused: { allowed: string[]; result: BatchResult } = { allowed: [], result: applied(0) };

const { put, stored } = plantedKit(
  () => a,
  () => b,
);

const del = (table: string, id: string, project: string): Change => ({
  ...put(table, id, project, {}),
  op: "del",
  data: null,
});

const project = (id: string): Change =>
  put("projects", id, id, {
    id,
    org_id: stubOrg,
    key: id,
    name: id,
    home_instance: b.instanceId,
    created_at: 1,
  });

const channelRow = (id: string, label: string): Change =>
  put("channels", id, label, {
    id,
    org_id: stubOrg,
    kind: "project",
    name: "taken over",
    project_id: label,
    created_at: 1,
  });

const message = (id: string, label: string, channel: string, root: string | null): Change =>
  put("messages", id, label, {
    id,
    channel_id: channel,
    thread_root_id: root,
    author_id: BEE,
    body: "planted",
    created_at: 1,
    edited_at: null,
  });

// The note a peer sends for a project: scope project, so it passes spec.only whatever id it takes.
const noteRow = (id: string, label: string, org: string, disk: string): Change =>
  put("notes", id, label, {
    id,
    disk,
    scope: "project",
    org_id: org,
    project_id: label,
    type: "fact",
    title: "taken over",
    tags: "[]",
    confidence: 0.5,
    created: 1,
    updated: 1,
    hash: "h",
    slug: "taken-over",
    title_key: "taken-over",
    body: "planted body",
  });

// Judged and applied the way the sync loop does, note files included.
function judge(...changes: Change[]): { allowed: string[]; result: BatchResult } {
  const { allowed } = permitInbound(a.db, b.instanceId, changes);
  return { allowed: ids(allowed), result: applyBatch(a.db, allowed, noteBodies(a.db, a.home)) };
}

const snapshot = (table: string, ...rowIds: string[]): string =>
  JSON.stringify(rowIds.map((id) => a.db.query(`SELECT * FROM ${table} WHERE id = ?`).get(id)));

const messageState = (): string =>
  JSON.stringify(a.db.query("SELECT id, channel_id, body FROM messages ORDER BY id").all());

async function makeNote(path: string): Promise<{ id: string; disk: string }> {
  const loc = resolveNotePath(path, viewer, projectSlugs(a.db, seed.orgId));
  if (loc === null || loc === "dir") throw new Error(`bad note path ${path}`);
  await createNote(a.db, a.home, { viewer, runId: null }, loc, `# ${path}\n\nlocal text`);
  const id = getIndexedByDisk(a.db, loc.disk)?.id;
  if (id === undefined) throw new Error(`note not indexed: ${path}`);
  return { id, disk: loc.disk };
}

// An org or dm channel with a home root and the peer member's reply to it: rows that belong to no
// project. Only one org channel fits an org, so each channel gets an org of its own.
function localThread(channel: string, kind: "org" | "dm"): { root: string; reply: string } {
  const root = `${channel}-root`;
  const reply = `${channel}-reply`;
  const org = `o-${channel}`;
  a.db.run("INSERT INTO orgs (id, slug, name, created_at) VALUES (?, ?, 'Local', 1)", [org, org]);
  a.db.run(
    "INSERT INTO channels (id, org_id, kind, name, dm_key, created_at) VALUES (?, ?, ?, 'x', ?, 1)",
    [channel, org, kind, kind === "dm" ? channel : null],
  );
  const say = (id: string, threadRoot: string | null, author: string): void =>
    void a.db.run(
      "INSERT INTO messages (id, channel_id, thread_root_id, author_id, body, created_at) VALUES (?, ?, ?, ?, 'local', 1)",
      [id, channel, threadRoot, author],
    );
  say(root, null, seed.memberId);
  say(reply, root, BEE);
  return { root, reply };
}

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
  viewer = {
    orgId: seed.orgId,
    memberId: null,
    projectIds: [seed.projectId, granted],
    canWriteGlobal: true,
    canWrite: true,
    actor: "ann",
  };
  judge(project(COPY));
});

afterAll(() => {
  a.stop();
  b.stop();
});

test("a write peer cannot delete a local global or org note through a project it was granted", async () => {
  const global = await makeNote("/memories/global/del-global.md");
  const org = await makeNote("/memories/org/del-org.md");
  const before = snapshot("notes", global.id, org.id);
  expect(judge(del("notes", global.id, granted), del("notes", org.id, granted))).toEqual(refused);
  expect(snapshot("notes", global.id, org.id)).toBe(before);
  expect([global, org].map((n) => readNoteText(a.home, n.disk)?.includes("local text"))).toEqual([
    true,
    true,
  ]);
});

test("a copy project peer cannot delete a local org or dm channel", () => {
  localThread("c-del-org", "org");
  localThread("c-del-dm", "dm");
  const state = (): string => snapshot("channels", "c-del-org", "c-del-dm") + messageState();
  const before = state();
  expect(judge(del("channels", "c-del-org", COPY), del("channels", "c-del-dm", COPY))).toEqual(
    refused,
  );
  expect(state()).toBe(before);
});

test("a put that passes the note filter does not take over a local global or org note", async () => {
  const global = await makeNote("/memories/global/put-global.md");
  const org = await makeNote("/memories/org/put-org.md");
  const before = snapshot("notes", global.id, org.id);
  const diskG = `orgs/${seed.orgId}/projects/${granted}/x.md`;
  const diskC = `orgs/${stubOrg}/projects/${COPY}/y.md`;
  const page = [
    noteRow(global.id, granted, seed.orgId, diskG),
    noteRow(org.id, COPY, stubOrg, diskC),
  ];
  expect(judge(...page)).toEqual(refused);
  expect(snapshot("notes", global.id, org.id)).toBe(before);
  expect(readNoteText(a.home, diskG) ?? readNoteText(a.home, diskC)).toBeNull();
});

test("a put that passes the channel filter does not take over a local org channel", () => {
  localThread("c-put-org", "org");
  const before = snapshot("channels", "c-put-org");
  expect(judge(project("q-chan"), channelRow("c-put-org", "q-chan"))).toEqual({
    allowed: ["projects:q-chan"],
    result: applied(1),
  });
  expect(snapshot("channels", "c-put-org")).toBe(before);
});

test("messages are not put into or over a local org or dm channel", () => {
  const org = localThread("c-put-msg-org", "org");
  const dm = localThread("c-put-msg-dm", "dm");
  const before = messageState();
  const page = [
    message("m-new-org", granted, "c-put-msg-org", null),
    message("m-new-dm", COPY, "c-put-msg-dm", null),
    message(org.reply, granted, "c-put-msg-org", org.root),
    message(dm.reply, COPY, "c-put-msg-dm", dm.root),
  ];
  expect(judge(...page)).toEqual(refused);
  expect(messageState()).toBe(before);
});

test("messages of a local org or dm channel are not deleted", () => {
  const org = localThread("c-del-msg-org", "org");
  const dm = localThread("c-del-msg-dm", "dm");
  const before = messageState();
  const page = [
    del("messages", org.reply, granted),
    del("messages", org.reply, COPY),
    del("messages", dm.reply, granted),
    del("messages", dm.reply, COPY),
  ];
  expect(judge(...page)).toEqual(refused);
  expect(messageState()).toBe(before);
});

test("a write peer still deletes a project note of the project it is labelled with", async () => {
  const note = await makeNote("/memories/project/GRT/del-own.md");
  expect(judge(del("notes", note.id, granted))).toEqual({
    allowed: [`notes:${note.id}`],
    result: applied(1),
  });
  expect(stored("notes", note.id)).toBe(0);
  expect(readNoteText(a.home, note.disk)).toBeNull();
});

test("a del of an id that is not stored here is still permitted", () => {
  const page = [
    del("notes", "n-never-stored", granted),
    del("messages", "m-never-stored", granted),
    del("channels", "c-never-stored", COPY),
  ];
  expect(ids(permitInbound(a.db, b.instanceId, page).allowed)).toEqual(ids(page));
});

test("a new project note with no stored row is applied with its file", () => {
  const disk = `orgs/${seed.orgId}/projects/${granted}/fresh.md`;
  const fresh = noteRow("n-fresh", granted, seed.orgId, disk);
  expect(judge(fresh)).toEqual({ allowed: ["notes:n-fresh"], result: applied(1) });
  expect(readNoteText(a.home, disk)).toContain("planted body");
});

test("a copy page keeps its channel, messages and comments, and a reply can be deleted again", () => {
  const q = "q-ctl";
  const page = [
    project(q),
    channelRow("ch-ctl", q),
    message("m-ctl-root", q, "ch-ctl", null),
    message("m-ctl-reply", q, "ch-ctl", "m-ctl-root"),
    put("tasks", "t-ctl", q, { ...taskRow("t-ctl", q, stubOrg), created_by: BEE }),
    put("comments", "c-ctl", q, {
      id: "c-ctl",
      task_id: "t-ctl",
      author_id: BEE,
      body: "fine",
      created_at: 1,
    }),
  ];
  expect(judge(...page)).toEqual({ allowed: ids(page), result: applied(6) });
  expect(judge(del("messages", "m-ctl-reply", q))).toEqual({
    allowed: ["messages:m-ctl-reply"],
    result: applied(1),
  });
  expect(stored("messages", "m-ctl-root") + stored("comments", "c-ctl")).toBe(2);
  expect(stored("messages", "m-ctl-reply")).toBe(0);
});
