import { expect, test } from "bun:test";
import { bootApi } from "../../test-support/api-kit";
import { addAgentMember } from "../orgs/api";

async function setup() {
  const k = bootApi();
  const owner = await k.user();
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
