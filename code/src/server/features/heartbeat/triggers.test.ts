import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { addComment, createTask, updateTask } from "../board/api";
import { postMessage } from "../chat/api";
import type { triageWake } from "../laya/api";
import { addAgentMember, createOrg, grantProject, listMembers, revokeGrant } from "../orgs/api";
import { holdRuns, type Kit, setup, until, wakes } from "./kit";

// Each run cuts a real git worktree, which is slow when the whole suite runs at once.
setDefaultTimeout(30_000);

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

const chitchat: typeof triageWake = async () => ({
  source: "laya",
  chitchat: 0.95,
  specialty: null,
  p: null,
});
const database: typeof triageWake = async () => ({
  source: "laya",
  chitchat: 0.1,
  specialty: "database",
  p: 0.82,
});

function boot(k: Kit, triage: typeof triageWake = chitchat): void {
  stops.push(k.start({ triage }));
}

const runsOf = (k: Kit, memberId: string): number =>
  k.db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM runs WHERE member_id = ?")
    .get(memberId)?.n ?? 0;

test("assigning a task to agent B creates one assignment wake and one run with member identity and scopes", async () => {
  const k = setup();
  const b = k.agent("bob");
  boot(k);
  const task = k.task("Fix login");
  updateTask(k.db, task.id, { assigneeId: b.id }, k.human.id);
  await until(() => wakes(k.db, b.id)[0]?.status === "done");
  expect(wakes(k.db, b.id).map((w) => w.reason)).toEqual(["assignment"]);
  expect(k.seen).toHaveLength(1);
  expect(k.seen[0]).toMatchObject({ memberId: b.id });
  expect(k.seen[0]?.scopes).toEqual(["report", "guard_hook", "board", "chat"]);
  expect(runsOf(k, b.id)).toBe(1);
});

test("creating a task already assigned to agent B wakes B, creating one for yourself does not", async () => {
  const k = setup();
  const b = k.agent("bob");
  boot(k);
  const input = { projectId: k.task("seed").projectId, title: "split", createdBy: k.human.id };
  createTask(k.db, { ...input, assigneeId: b.id });
  createTask(k.db, { ...input, assigneeId: k.human.id });
  await until(() => wakes(k.db, b.id)[0]?.status === "done");
  expect(wakes(k.db, b.id).map((w) => w.reason)).toEqual(["assignment"]);
  expect(wakes(k.db, k.human.id)).toHaveLength(0);
});

test("a human assigning to a human, and B commenting on its own task, wake nobody", async () => {
  const k = setup();
  const b = k.agent("bob");
  boot(k);
  const own = k.task("mine");
  updateTask(k.db, own.id, { assigneeId: k.human.id }, k.human.id);
  const theirs = k.task("theirs");
  updateTask(k.db, theirs.id, { assigneeId: b.id }, k.human.id);
  await until(() => wakes(k.db, b.id)[0]?.status === "done");
  addComment(k.db, theirs.id, b.id, "progress");
  await Bun.sleep(100);
  expect(wakes(k.db, b.id)).toHaveLength(1);
  expect(k.db.query("SELECT 1 FROM wakeups WHERE member_id = ?").get(k.human.id)).toBeNull();
});

test("a comment from someone else wakes the assignee", async () => {
  const k = setup();
  const b = k.agent("bob");
  const task = k.task("t");
  boot(k);
  updateTask(k.db, task.id, { assigneeId: b.id }, k.human.id);
  await until(() => wakes(k.db, b.id)[0]?.status === "done");
  addComment(k.db, task.id, k.human.id, "please add a test");
  await until(() => wakes(k.db, b.id).length === 2 && wakes(k.db, b.id)[1]?.status === "done");
  expect(wakes(k.db, b.id)[1]?.reason).toBe("comment");
  expect(k.seen[1]?.prompt).toContain("please add a test");
});

test("mentions between two agents batch into one run each and never wake the author", async () => {
  const k = setup();
  const a = k.agent("amy");
  const b = k.agent("bob");
  const channel = k.teamChannel.id;
  holdRuns(k);
  boot(k);
  const say = (authorId: string, to: string): void => {
    postMessage(k.db, { channelId: channel, authorId, body: `@${to} ping` });
  };
  say(a.id, "bob");
  await until(() => runsOf(k, b.id) === 1);
  say(a.id, "bob");
  say(a.id, "bob");
  say(b.id, "amy");
  await until(() => runsOf(k, a.id) === 1);
  say(b.id, "amy");
  say(b.id, "amy");
  await until(() => wakes(k.db, a.id).length === 3 && wakes(k.db, b.id).length === 3);
  k.hold.release();
  await until(() => runsOf(k, a.id) === 2 && runsOf(k, b.id) === 2);
  await until(() => wakes(k.db, a.id).every((w) => w.status === "done"));
  await until(() => wakes(k.db, b.id).every((w) => w.status === "done"));
  for (const m of [a, b]) {
    expect(wakes(k.db, m.id).some((w) => w.caused_by === m.id)).toBe(false);
    expect(new Set(wakes(k.db, m.id).map((w) => w.run_id)).size).toBe(2);
  }
});

test("the 21st wake in an hour is skipped and logs one error event", async () => {
  const k = setup();
  const b = k.agent("bob");
  const now = Date.now();
  for (let i = 0; i < 20; i++) {
    k.db.run(
      "INSERT INTO wakeups (id, member_id, reason, status, run_id, created_at, started_at) VALUES (?, ?, 'schedule', 'done', ?, ?, ?)",
      [Bun.randomUUIDv7(), b.id, Bun.randomUUIDv7(), now - 1000, now - 1000],
    );
  }
  boot(k);
  const task = k.task("t");
  updateTask(k.db, task.id, { assigneeId: b.id }, k.human.id);
  updateTask(k.db, task.id, { assigneeId: b.id }, k.human.id);
  await until(() => wakes(k.db, b.id).filter((w) => w.status === "skipped").length === 2);
  expect(wakes(k.db, b.id).filter((w) => w.status === "skipped")[0]?.detail).toContain("hourly");
  expect(k.seen).toHaveLength(0);
  const errors = k.db
    .query("SELECT 1 FROM events WHERE kind = 'error' AND source = 'heartbeat'")
    .all();
  expect(errors).toHaveLength(1);
});

test("laya chitchat wakes nobody; a database message wakes only agents with that specialty", async () => {
  const k = setup();
  const db = k.agent("dba", ["database"]);
  const fe = k.agent("fe", ["frontend"]);
  const human = k.human.id;
  const post = (body: string): void => {
    postMessage(k.db, { channelId: k.teamChannel.id, authorId: human, body });
  };
  boot(k, chitchat);
  post("thanks everyone, nice work today");
  await Bun.sleep(100);
  expect(wakes(k.db, db.id)).toHaveLength(0);
  stops.pop()?.();
  boot(k, database);
  post("the orders table needs an index on customer_id");
  await until(() => wakes(k.db, db.id)[0]?.status === "done");
  const wake = wakes(k.db, db.id)[0];
  expect(wake?.reason).toBe("laya_mention");
  expect(JSON.parse(wake?.detail ?? "{}").triage).toMatchObject({ specialty: "database", p: 0.82 });
  expect(wakes(k.db, fe.id)).toHaveLength(0);
  expect(listMembers(k.db, k.orgId).length).toBe(3);
});

test("an explicit mention skips Laya", async () => {
  const k = setup();
  const b = k.agent("bob", ["database"]);
  let calls = 0;
  boot(k, async (text) => {
    calls++;
    return database(text);
  });
  postMessage(k.db, {
    channelId: k.teamChannel.id,
    authorId: k.human.id,
    body: "@bob look at the schema",
  });
  await until(() => wakes(k.db, b.id)[0]?.status === "done");
  expect(wakes(k.db, b.id).map((w) => w.reason)).toEqual(["mention"]);
  expect(calls).toBe(0);
});

test("an agent-authored message without a mention skips Laya, a human one does not", async () => {
  const k = setup();
  const dba = k.agent("dba", ["database"]);
  const other = k.agent("other");
  let calls = 0;
  boot(k, async (text) => {
    calls++;
    return database(text);
  });
  postMessage(k.db, {
    channelId: k.teamChannel.id,
    authorId: other.id,
    body: "index the orders table",
  });
  await Bun.sleep(100);
  expect(calls).toBe(0);
  expect(wakes(k.db, dba.id)).toHaveLength(0);
  postMessage(k.db, {
    channelId: k.teamChannel.id,
    authorId: k.human.id,
    body: "index the orders table",
  });
  await until(() => wakes(k.db, dba.id).length === 1);
  expect(calls).toBe(1);
});

test("a grantee agent needs write access to be woken, and a revoked grant stops comment wakes", async () => {
  const k = setup();
  const beta = createOrg(k.db, {
    name: "B",
    slug: "beta",
    ownerUserId: "u2",
    ownerName: "B",
    ownerHandle: "bee",
  });
  const guest = addAgentMember(k.db, beta.id, {
    agentId: "fake",
    handle: "guest",
    displayName: "g",
    specialties: [],
  });
  boot(k);
  grantProject(k.db, k.projectId, beta.id, "read", k.human.id);
  const task = k.task("t");
  updateTask(k.db, task.id, { assigneeId: guest.id }, k.human.id);
  expect(wakes(k.db, guest.id)).toHaveLength(0);
  grantProject(k.db, k.projectId, beta.id, "write", k.human.id);
  addComment(k.db, task.id, k.human.id, "now you can");
  await until(() => wakes(k.db, guest.id)[0]?.status === "done");
  revokeGrant(k.db, k.projectId, beta.id);
  addComment(k.db, task.id, k.human.id, "secret plans");
  await Bun.sleep(100);
  expect(wakes(k.db, guest.id)).toHaveLength(1);
});
