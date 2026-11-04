import type { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import type { Notification } from "../../../shared/notify";
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

test("a run that ends blocked notifies its org owners and admins, not members or other orgs", async () => {
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
  for (const id of [a.owner, plain, b.owner]) {
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
  expect(blocked.map((s) => s.memberId)).toEqual([a.owner]);
  expect(blocked[0]?.n).toMatchObject({
    title: "Run blocked",
    tag: `run:${id}`,
    path: `/#/runs/${id}`,
  });
});
