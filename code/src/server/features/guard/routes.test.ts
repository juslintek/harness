import { expect, test } from "bun:test";
import { bootApi } from "../../test-support/api-kit";
import { addAgentMember } from "../orgs/api";

async function setup(command = "git push", l1 = "{}") {
  const k = bootApi();
  const owner = await k.user({ stepUp: true });
  const acme = k.org(owner, "acme");
  const agent = addAgentMember(k.db, acme.id, {
    agentId: "fake",
    handle: "bob",
    displayName: "bob",
    specialties: [],
  });
  const runId = Bun.randomUUIDv7();
  k.db.run(
    "INSERT INTO runs (id, agent_id, repo, prompt, state, created_at, member_id) VALUES (?, 'fake', '/r', 'p', 'running', ?, ?)",
    [runId, Date.now(), agent.id],
  );
  const approvalId = Bun.randomUUIDv7();
  k.db.run(
    "INSERT INTO approvals (id, run_id, action, l1, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
    [approvalId, runId, JSON.stringify({ command, paths: [] }), l1, 1, Date.now() + 60_000],
  );
  return { k, owner, approvalId };
}

test("an org owner decides and lists approvals of its own agent's runs", async () => {
  const { k, owner, approvalId } = await setup();
  const list = await (await k.call(owner, "GET", "/api/approvals?status=pending")).json();
  expect(list.map((a: { id: string }) => a.id)).toEqual([approvalId]);
  const res = await k.call(owner, "POST", `/api/approvals/${approvalId}`, { decision: "approve" });
  expect(res.status).toBe(200);
});

test("an admin of another org neither sees nor decides them", async () => {
  const { k, approvalId } = await setup();
  const other = await k.user({ stepUp: true });
  k.org(other, "beta");
  expect(await (await k.call(other, "GET", "/api/approvals")).json()).toEqual([]);
  const res = await k.call(other, "POST", `/api/approvals/${approvalId}`, { decision: "approve" });
  expect(res.status).toBe(403);
});

test("a plain member of the org may not decide, the instance admin still may", async () => {
  const { k, approvalId } = await setup();
  const org = k.db.query<{ id: string }, []>("SELECT id FROM orgs").get();
  const member = await k.user({ stepUp: true });
  k.join(org?.id as string, member, "member", "mem");
  const denied = await k.call(member, "POST", `/api/approvals/${approvalId}`, { decision: "deny" });
  expect(denied.status).toBe(403);
  const admin = await k.user({ admin: true, stepUp: true });
  const ok = await k.call(admin, "POST", `/api/approvals/${approvalId}`, { decision: "deny" });
  expect(ok.status).toBe(200);
});

test("deciding still needs a fresh step-up", async () => {
  const { k, approvalId } = await setup();
  const org = k.db.query<{ id: string }, []>("SELECT id FROM orgs").get();
  const admin = await k.user();
  k.join(org?.id as string, admin, "admin", "adm");
  const res = await k.call(admin, "POST", `/api/approvals/${approvalId}`, { decision: "approve" });
  expect(res.status).not.toBe(200);
});

test("an org owner may not approve what only the instance admin may, the instance admin may", async () => {
  const { k, owner, approvalId } = await setup(
    "curl https://x.test",
    JSON.stringify({ category: "network", rule: "net.fetch" }),
  );
  const res = await k.call(owner, "POST", `/api/approvals/${approvalId}`, { decision: "approve" });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({
    error: "instance_admin_required",
    reason: "network and secret actions need a human",
  });
  const admin = await k.user({ admin: true, stepUp: true });
  const ok = await k.call(admin, "POST", `/api/approvals/${approvalId}`, { decision: "approve" });
  expect(ok.status).toBe(200);
});

test("an org owner may not approve a write into the harness home", async () => {
  const { k, owner, approvalId } = await setup("sqlite3 /unused/harness.db");
  const res = await k.call(owner, "POST", `/api/approvals/${approvalId}`, { decision: "approve" });
  expect(res.status).toBe(403);
  expect((await res.json()).reason).toBe("the action touches the harness home");
});
