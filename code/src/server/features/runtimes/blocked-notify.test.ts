import type { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import type { Notification } from "../../../shared/notify";
import { createApp } from "../../http";
import { createSession } from "../auth/api";
import { addTarget, setPref, startNotify } from "../notify/api";
import { addAgentMember, addHumanMember, createOrg } from "../orgs/api";
import { startRun, waitForRun } from "./api";
import { cleanup, fakeDeps, fixture } from "./manager-kit";

afterAll(cleanup);

function seedOrg(db: Database, slug: string, user: string): { orgId: string; owner: string } {
  db.run("INSERT INTO users (id, email, name, instance_admin, created_at) VALUES (?, ?, ?, 0, 1)", [
    user,
    `${slug}@example.test`,
    slug,
  ]);
  const org = createOrg(db, {
    name: slug,
    slug,
    ownerUserId: user,
    ownerName: slug,
    ownerHandle: slug,
  });
  const owner = db
    .query<{ id: string }, [string]>("SELECT id FROM members WHERE org_id = ?")
    .get(org.id);
  return { orgId: org.id, owner: owner?.id as string };
}

function runViewers(db: Database, orgId: string, otherOwner: string): string[] {
  db.run("UPDATE users SET instance_admin = 1 WHERE id = 'u-b'");
  for (const [id, admin] of [
    ["u-root", 1],
    ["u-admin", 0],
  ] as const) {
    db.run(
      "INSERT INTO users (id, email, name, instance_admin, created_at) VALUES (?, ?, ?, ?, 1)",
      [id, `${id}@example.test`, id, admin],
    );
  }
  const root = addHumanMember(db, orgId, "u-root", "root", "root", "member");
  addHumanMember(db, orgId, "u-admin", "admin", "admin", "admin");
  return [root.id, otherOwner];
}

async function runStatus(db: Database, memberId: string, runId: string): Promise<number> {
  const member = db
    .query<{ user_id: string }, [string]>("SELECT user_id FROM members WHERE id = ?")
    .get(memberId);
  const { token } = createSession(db, member?.user_id as string, "passkey", null);
  const app = createApp({
    db,
    home: "/unused",
    port: 4100,
    rp: { id: "localhost", name: "Harness", origin: "http://localhost:4100" },
    instanceId: "i",
    version: "1",
  });
  return (
    await app.request(`/api/runs/${runId}`, {
      headers: { host: "localhost:4100", cookie: `harness_session=${token}` },
    })
  ).status;
}

test("a blocked run notifies only instance admins who can open its run page", async () => {
  const x = fixture();
  const sent: { memberId: string; n: Notification }[] = [];
  const stop = startNotify(x.db, {
    home: x.home,
    origin: "https://h.test",
    adapters: {
      push: {
        channel: "push",
        deliver: async (target, n) => {
          sent.push({ memberId: target.memberId, n });
          return { ok: true };
        },
      },
    },
  });
  const a = seedOrg(x.db, "acme", "u-a");
  const b = seedOrg(x.db, "other", "u-b");
  const viewers = runViewers(x.db, a.orgId, b.owner);
  x.db.run(
    "INSERT INTO users (id, email, name, instance_admin, created_at) VALUES ('u-m', 'm@example.test', 'm', 0, 1)",
  );
  const plain = addHumanMember(x.db, a.orgId, "u-m", "plain", "plain", "member").id;
  const agent = addAgentMember(x.db, a.orgId, {
    agentId: "a",
    handle: "bot",
    displayName: "bot",
    specialties: [],
  }).id;
  const admin = x.db
    .query<{ id: string }, []>("SELECT id FROM members WHERE user_id = 'u-admin'")
    .get()?.id as string;
  for (const id of [a.owner, plain, admin, ...viewers]) {
    addTarget(x.db, id, "push", { endpoint: `https://push.test/${id}`, p256dh: "k", auth: "a" });
    setPref(x.db, id, "push", "run_blocked", true);
  }
  const script = [{ ask: { command: "git push origin feature/x" } }, { say: "after" }];
  const id = await startRun(x.db, fakeDeps(x, script, { approvalTimeoutMs: 200 }), {
    agentId: "fake",
    repo: x.repo,
    prompt: "go",
    member: { memberId: agent, orgId: a.orgId, scopes: ["report", "guard_hook"] },
  });
  expect((await waitForRun(id)).state).toBe("blocked");
  await stop();
  const blocked = sent.filter((s) => s.n.kind === "run_blocked");
  expect(blocked.map((s) => s.memberId).sort()).toEqual(viewers.sort());
  for (const sent of blocked) expect(await runStatus(x.db, sent.memberId, id)).toBe(200);
  for (const member of [a.owner, admin, plain]) {
    expect(await runStatus(x.db, member, id)).toBe(403);
  }
  expect(blocked[0]?.n).toMatchObject({
    title: "Run blocked",
    tag: `run:${id}`,
    path: `/#/runs/${id}`,
  });
});
