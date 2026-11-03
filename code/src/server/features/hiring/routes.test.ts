import { afterEach, expect, test } from "bun:test";
import type { RoleSpec } from "../../../shared/hiring";
import { bootApi } from "../../test-support/api-kit";
import { listTeams } from "../orgs/api";
import { type HiringDeps, startHiring } from "./api";

const spec: RoleSpec = {
  title: "Backend Engineer",
  specialty: "backend",
  summary: "own the billing API",
  mustHave: [],
  taskTypes: ["feature"],
};

const deps: HiringDeps = {
  pickEngines: () => Promise.resolve([{ runtime: "claude", model: null }]),
  engineReady: () => true,
  budgetPaused: () => false,
  startInterview: () => {},
  wake: () => {},
};

let stop = (): void => {};
afterEach(() => stop());

async function world() {
  const k = bootApi();
  stop = startHiring(k.db, deps, null);
  const owner = await k.user({ stepUp: true });
  const a = k.org(owner, "acme");
  const teamId = listTeams(k.db, a.id)[0]?.id as string;
  const stranger = await k.user({ stepUp: true });
  k.org(stranger, "other");
  const count = (): number =>
    k.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM hire_requests").get()?.n as number;
  return { k, owner, stranger, a, teamId, count };
}

test("members file a request, viewers cannot", async () => {
  const { k, a, teamId, count } = await world();
  const viewer = await k.user();
  k.join(a.id, viewer, "viewer", "vee");
  const body = { teamId, spec };
  expect((await k.call(viewer, "POST", "/api/orgs/acme/hires", body)).status).toBe(403);
  expect(count()).toBe(0);
  const member = await k.user();
  k.join(a.id, member, "member", "mem");
  expect((await k.call(member, "POST", "/api/orgs/acme/hires", body)).status).toBe(201);
  expect(count()).toBe(1);
});

test("an admin of another org gets nothing on this org's hire and writes nothing", async () => {
  const { k, owner, stranger, teamId, count } = await world();
  const hire = await (await k.call(owner, "POST", "/api/orgs/acme/hires", { teamId, spec })).json();
  const candidate = hire.candidates[0].id as string;
  k.db.query("UPDATE hire_requests SET status = 'scoring'").run();

  for (const [method, path, body] of [
    ["GET", "/api/orgs/acme/hires", undefined],
    ["GET", `/api/orgs/acme/hires/${hire.id}`, undefined],
    ["POST", "/api/orgs/acme/hires", { teamId, spec }],
    [
      "POST",
      `/api/orgs/acme/hires/${hire.id}/score/${candidate}`,
      { fit: 5, depth: 5, honesty: 5 },
    ],
    ["POST", `/api/orgs/acme/hires/${hire.id}/decide`, { candidateId: candidate, reason: "" }],
  ] as const) {
    const res = await k.call(stranger, method, path, body);
    expect([403, 404]).toContain(res.status);
  }
  // Their own org's slug must not let them reach it either.
  const viaOwn = await k.call(stranger, "GET", `/api/orgs/other/hires/${hire.id}`);
  expect(viaOwn.status).toBe(404);
  const scored = await k.call(
    stranger,
    "POST",
    `/api/orgs/other/hires/${hire.id}/score/${candidate}`,
    { fit: 5, depth: 5, honesty: 5 },
  );
  expect(scored.status).toBe(404);
  expect(count()).toBe(1);
  expect(k.db.query("SELECT 1 FROM scorecards").get()).toBeNull();
  expect(k.db.query<{ status: string }, []>("SELECT status FROM hire_requests").get()?.status).toBe(
    "scoring",
  );
});

test("filing is refused with a reason while the requester's budget is exhausted", async () => {
  const { k, owner, teamId } = await world();
  stop();
  stop = startHiring(k.db, { ...deps, budgetPaused: () => true }, null);
  const res = await k.call(owner, "POST", "/api/orgs/acme/hires", { teamId, spec });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect((await res.json()).error).toBe("your budget is exhausted, so no new interviews can start");
  expect(k.db.query("SELECT 1 FROM hire_requests").get()).toBeNull();
});

test("decide needs step-up, and a second decide is a conflict", async () => {
  const { k, owner, teamId } = await world();
  const hire = await (await k.call(owner, "POST", "/api/orgs/acme/hires", { teamId, spec })).json();
  k.db.query("UPDATE hire_requests SET status = 'deciding'").run();
  const plain = await k.user();
  const a = k.db.query<{ id: string }, []>("SELECT id FROM orgs WHERE slug = 'acme'").get();
  k.join(a?.id as string, plain, "admin", "adm");
  const path = `/api/orgs/acme/hires/${hire.id}/decide`;
  const denied = await k.call(plain, "POST", path, { candidateId: null, reason: "no" });
  expect(denied.status).toBe(403);
  expect((await denied.json()).error).toBe("step_up_required");

  expect((await k.call(owner, "POST", path, { candidateId: null, reason: "no" })).status).toBe(200);
  const again = await k.call(owner, "POST", path, { candidateId: null, reason: "no" });
  expect(again.status).toBe(409);
  expect((await again.json()).error).toBe("already decided");
});
