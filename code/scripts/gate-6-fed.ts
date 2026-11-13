// Gate 6 assertions 4 to 6: sync both ways, leases, and a grep of every feed body A served
// for anything that must stay local.
import { getSecret } from "../src/server/features/agents/api";
import { checkoutTask, createTask, updateTask } from "../src/server/features/board/api";
import { addHumanMember } from "../src/server/features/orgs/api";
import { sessionHeaders } from "../src/server/test-support/app-kit";
import { waitFor } from "./gate-5-kit";
import { call, type GateLog } from "./gate-6-kit";
import {
  boot,
  holderOf,
  type Seeded,
  type Side,
  sameContent,
  seedA,
  startRecorder,
  stubMember,
  titleOf,
  userOf,
} from "./gate-6-nodes";

async function connect(log: GateLog, a: Side, b: Side, s: Seeded): Promise<string> {
  const invite = await call(a.inst.client, "POST", "/api/federation/invites", a.cookie);
  const paired = await call(b.inst.client, "POST", "/api/federation/peers/pair", b.cookie, {
    url: a.inst.origin,
    token: invite.json.token,
  });
  const shared = await call(a.inst.client, "POST", "/api/federation/shares", a.cookie, {
    projectId: s.projectId,
    peerId: b.id,
    permission: "write",
  });
  log.report.check(
    4,
    paired.status === 200 && shared.status === 201,
    `paired (${paired.status}) and shared (${shared.status})`,
  );
  const bMember = await waitFor(
    "B member in the grantee org",
    () => sameContent(a, b, s) && stubMember(b, userOf(b)),
  );
  log.report.check(4, true, "B copy has tasks, comments, channel message and the project note");
  return bMember;
}

// Both sides edit the same title in one tick, so neither can have seen the other's edit.
async function syncChecks(
  log: GateLog,
  a: Side,
  b: Side,
  s: Seeded,
  bMember: string,
): Promise<void> {
  const t0 = s.tasks[0] as string;
  updateTask(b.inst.db, t0, { title: "first, edited on B" }, bMember);
  await waitFor("edit on B to reach A", () => titleOf(a, t0) === "first, edited on B");
  log.report.check(4, true, "an edit made on B reached A");
  const t1 = s.tasks[1] as string;
  updateTask(a.inst.db, t1, { title: "second, A version" }, s.member);
  updateTask(b.inst.db, t1, { title: "second, B version" }, bMember);
  await waitFor("conflict to converge", () => titleOf(a, t1) === titleOf(b, t1));
  await Bun.sleep(1500);
  const settled =
    titleOf(a, t1) === titleOf(b, t1) && /A version|B version/.test(titleOf(a, t1) ?? "");
  log.report.check(4, settled, `conflicting edit settled on "${titleOf(a, t1)}" on both`);
  const later = createTask(a.inst.db, {
    projectId: s.projectId,
    title: "after share",
    createdBy: s.member,
  }).id;
  await waitFor("task created after the share", () => titleOf(b, later) === "after share");
  log.report.check(4, true, "a task created on A after the share arrived on B");
}

// A member A adds after the share was never in the first export; the copy still has to show
// who holds the task.
async function lateMember(log: GateLog, a: Side, b: Side, s: Seeded): Promise<void> {
  const { userId } = await sessionHeaders(a.inst.db, {});
  const bob = addHumanMember(a.inst.db, s.orgId, userId, "bob", "Bob", "member");
  const task = createTask(a.inst.db, {
    projectId: s.projectId,
    title: "bob's",
    createdBy: s.member,
  }).id;
  await waitFor("task on B", () => titleOf(b, task));
  const res = await checkoutTask(a.inst.db, task, bob.id);
  const shown = await waitFor("holder on B", () => holderOf(b, task) === bob.id).catch(() => false);
  log.report.check(
    5,
    res.ok && shown,
    "a task held by an owner-side member added after the share shows on the copy",
  );
}

async function leaseChecks(
  log: GateLog,
  a: Side,
  b: Side,
  s: Seeded,
  bMember: string,
  spare: string,
): Promise<void> {
  await lateMember(log, a, b, s);
  const race = createTask(a.inst.db, {
    projectId: s.projectId,
    title: "race",
    createdBy: s.member,
  }).id;
  await waitFor("race task on B", () => titleOf(b, race));
  const results = await Promise.allSettled([
    checkoutTask(a.inst.db, race, s.member),
    checkoutTask(b.inst.db, race, bMember),
  ]);
  const won = results.filter((r) => r.status === "fulfilled" && r.value.ok).length;
  await waitFor("one holder on both sides", () => {
    const h = holderOf(a, race);
    return h && h === holderOf(b, race) && [s.member, bMember].includes(h);
  });
  log.report.check(
    5,
    won === 1,
    `simultaneous checkout: ${won} winner, holder ${holderOf(a, race)} on both sides`,
  );
  await a.stopLoops();
  await a.inst.stop();
  const refused = await checkoutTask(b.inst.db, spare, bMember).then(
    (r) => !r.ok,
    () => true,
  );
  log.report.check(
    5,
    refused && !holderOf(b, spare),
    "home stopped: a checkout on the copy is refused",
  );
}

function leakChecks(log: GateLog, a: Side, s: Seeded, bodies: string[], secret: string): void {
  const repo = (
    a.inst.db
      .query<{ repo: string }, [string]>("SELECT repo FROM projects WHERE id = ?")
      .get(s.projectId) as { repo: string }
  ).repo;
  const key = getSecret("federation.key", a.inst.home) ?? "";
  const needles = { secret, agent_id: "agent_id", "federation.key": key, "repo path": repo };
  const joined = bodies.join("\n");
  const found = Object.entries(needles)
    .filter(([, text]) => text.length > 0 && joined.includes(text))
    .map(([name]) => name);
  log.print(`captured ${bodies.length} feed bodies, ${joined.length} bytes`);
  log.report.check(
    6,
    bodies.length > 0 &&
      joined.includes("hello from A") &&
      joined.includes("zebra") &&
      key.length > 20 &&
      found.length === 0,
    `no leak in feed bodies (found: ${found.join(",") || "none"})`,
  );
}

export async function runFederationPart(log: GateLog): Promise<void> {
  const rec = startRecorder();
  const secret = `gate6-secret-${crypto.randomUUID()}`;
  const a = await boot("a", `http://localhost:${rec.port}`);
  rec.upstream.port = a.inst.port;
  const b = await boot("b");
  try {
    const seeded = await seedA(a, secret);
    const bMember = await connect(log, a, b, seeded);
    await syncChecks(log, a, b, seeded, bMember);
    const spare = createTask(a.inst.db, {
      projectId: seeded.projectId,
      title: "spare",
      createdBy: seeded.member,
    }).id;
    await waitFor("spare task on B", () => titleOf(b, spare));
    await leaseChecks(log, a, b, seeded, bMember, spare);
    leakChecks(log, a, seeded, rec.bodies, secret);
  } finally {
    await b.stopLoops();
    await b.inst.stop();
    rec.stop();
  }
}
