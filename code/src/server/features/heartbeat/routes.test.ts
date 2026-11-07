import { expect, test } from "bun:test";
import { bootApi } from "../../test-support/api-kit";
import { openDm } from "../chat/api";
import { approvalView, decideApproval, findApproval } from "../guard/api";
import { addAgentMember } from "../orgs/api";
import { onApprovalResolved } from "./approval-wakes";

async function setup() {
  const k = bootApi();
  const owner = await k.user({ stepUp: true });
  const a = k.org(owner, "acme");
  const agent = addAgentMember(k.db, a.id, {
    agentId: "fake",
    handle: "bob",
    displayName: "bob",
    specialties: [],
  });
  return { k, owner, a, agent };
}

test("run now needs an admin of the member's org and shows up in the wakeups list", async () => {
  const { k, owner, a, agent } = await setup();
  const plain = await k.user();
  k.join(a.id, plain, "member", "plain");
  const stranger = await k.user();
  k.org(stranger, "beta");
  const path = `/api/members/${agent.id}/wake`;
  expect((await k.call(plain, "POST", path)).status).toBe(403);
  expect((await k.call(stranger, "POST", path)).status).toBe(404);
  const res = await k.call(owner, "POST", path);
  expect(res.status).toBe(202);
  const list = await (await k.call(plain, "GET", "/api/orgs/acme/wakeups?limit=5")).json();
  expect(list).toMatchObject([{ id: (await res.json()).id, reason: "run_now", status: "pending" }]);
  expect((await k.call(stranger, "GET", "/api/orgs/acme/wakeups")).status).toBe(404);
  expect((await k.call(owner, "GET", "/api/orgs/acme/wakeups?limit=0")).status).toBe(400);
});

test("run now on a human member is a 400", async () => {
  const { k, owner, a } = await setup();
  const res = await k.call(owner, "POST", `/api/members/${a.owner.id}/wake`);
  expect(res.status).toBe(400);
});

test("the wakeups list carries no message text and hides a DM from non-participants", async () => {
  const { k, owner, a, agent } = await setup();
  const plain = await k.user();
  k.join(a.id, plain, "member", "plain");
  const dm = openDm(k.db, a.owner.id, agent.id);
  k.db.run(
    "INSERT INTO wakeups (id, member_id, reason, channel_id, message_id, detail, status, created_at) VALUES (?, ?, 'mention', ?, 'm1', ?, 'pending', ?)",
    [
      Bun.randomUUIDv7(),
      agent.id,
      dm.id,
      JSON.stringify({ excerpt: "the secret plan" }),
      Date.now(),
    ],
  );
  const hidden = await (await k.call(plain, "GET", "/api/orgs/acme/wakeups")).text();
  expect(hidden).not.toContain("secret plan");
  expect(hidden).not.toContain(dm.id);
  expect(JSON.parse(hidden)[0]).toMatchObject({ channelId: null, channelName: null });
  const shown = await (await k.call(owner, "GET", "/api/orgs/acme/wakeups")).text();
  expect(shown).not.toContain("secret plan");
  expect(JSON.parse(shown)[0]).toMatchObject({ channelId: dm.id, channelName: dm.name });
});

test("run now over the hourly cap is a 429", async () => {
  const { k, owner, agent } = await setup();
  for (let i = 0; i < 20; i++) {
    k.db.run(
      "INSERT INTO wakeups (id, member_id, reason, status, run_id, created_at, started_at) VALUES (?, ?, 'schedule', 'done', ?, ?, ?)",
      [Bun.randomUUIDv7(), agent.id, Bun.randomUUIDv7(), Date.now(), Date.now()],
    );
  }
  const res = await k.call(owner, "POST", `/api/members/${agent.id}/wake`);
  expect(res.status).toBe(429);
  expect(await res.json()).toEqual({ error: "wake_cap" });
});

test("run now needs a fresh step-up even for an admin", async () => {
  const { k, a, agent } = await setup();
  const code = await k.user();
  k.join(a.id, code, "admin", "adm");
  const res = await k.call(code, "POST", `/api/members/${agent.id}/wake`);
  expect(res.status).toBe(403);
  expect((await res.json()).error).toBe("step_up_required");
});

test("run now on a viewer agent is refused with a 409", async () => {
  const { k, owner, agent } = await setup();
  k.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", [agent.id]);
  const res = await k.call(owner, "POST", `/api/members/${agent.id}/wake`);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "viewer" });
});

test("HTTP wakeups hide approval commands from members who cannot read the approval", async () => {
  const { k, owner, a, agent } = await setup();
  const plain = await k.user();
  k.join(a.id, plain, "member", "plain");
  const runId = Bun.randomUUIDv7();
  const approvalId = Bun.randomUUIDv7();
  const command = "git push private-origin private-branch";
  k.db.run(
    "INSERT INTO runs (id, member_id, agent_id, repo, prompt, state, created_at) VALUES (?, ?, 'fake', '/r', 'p', 'killed', ?)",
    [runId, agent.id, Date.now()],
  );
  k.db.run(
    "INSERT INTO approvals (id, run_id, action, l1, status, created_at, expires_at) VALUES (?, ?, ?, '{}', 'pending', 1, ?)",
    [approvalId, runId, JSON.stringify({ command }), Date.now() + 60_000],
  );
  expect(decideApproval(k.db, approvalId, "deny", owner.userId)).toBe(true);
  const approval = findApproval(k.db, approvalId);
  expect(approval).not.toBeNull();
  if (!approval) throw new Error("approval missing");
  expect(onApprovalResolved(k.db, approvalView(approval))).toBe(true);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: k.app.fetch });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const denied = await fetch(`${base}/api/approvals/${approvalId}`, { headers: plain.headers });
    expect(denied.status).toBe(404);
    const response = await fetch(`${base}/api/orgs/acme/wakeups`, { headers: plain.headers });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(command);
    expect(body).not.toContain("private-origin");
    expect(JSON.parse(body)[0].detail).toEqual({
      kind: "command",
      outcome: "denied",
      approval: approvalId,
    });
    const stored = k.db.query<{ detail: string }, []>("SELECT detail FROM wakeups").get();
    expect(stored?.detail).toContain(command);
  } finally {
    await server.stop(true);
    k.db.close();
  }
});
