import { expect, test } from "bun:test";
import { bootApi } from "../../test-support/api-kit";
import { addAgentMember } from "../orgs/api";

async function setup() {
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
    "INSERT INTO approvals (id, run_id, action, l1, status, created_at, expires_at) VALUES (?, ?, ?, '{}', 'pending', 1, ?)",
    [approvalId, runId, JSON.stringify({ command: "git push", paths: [] }), Date.now() + 60_000],
  );
  return { k, owner, acme, approvalId, runId };
}

test("an org admin gets the view of one approval", async () => {
  const { k, owner, approvalId, runId } = await setup();
  const res = await k.call(owner, "GET", `/api/approvals/${approvalId}`);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    id: approvalId,
    runId,
    command: "git push",
    status: "pending",
  });
});

test("an admin of another org gets 404, same as for an unknown id", async () => {
  const { k, approvalId } = await setup();
  const other = await k.user({ stepUp: true });
  k.org(other, "beta");
  expect((await k.call(other, "GET", `/api/approvals/${approvalId}`)).status).toBe(404);
});

test("a plain member gets 404", async () => {
  const { k, acme, approvalId } = await setup();
  const member = await k.user({ stepUp: true });
  k.join(acme.id, member, "member", "mem");
  expect((await k.call(member, "GET", `/api/approvals/${approvalId}`)).status).toBe(404);
});

test("without a session it is 401, and an unknown id is 404", async () => {
  const { k, owner, approvalId } = await setup();
  expect(
    (await k.app.request(`/api/approvals/${approvalId}`, { headers: { host: "localhost:4100" } }))
      .status,
  ).toBe(401);
  expect((await k.call(owner, "GET", `/api/approvals/${Bun.randomUUIDv7()}`)).status).toBe(404);
});
