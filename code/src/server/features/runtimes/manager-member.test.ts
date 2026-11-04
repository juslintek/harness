import { afterAll, expect, test } from "bun:test";
import { verifyRunToken } from "../mcp/api";
import { addAgentMember, createOrg } from "../orgs/api";
import type { RunOutcome } from "./adapter";
import { startRun, waitForRun } from "./api";
import { cleanup, fakeDeps, fixture } from "./manager-kit";

afterAll(cleanup);

const done: RunOutcome = {
  stopReason: "end_turn",
  text: "",
  usage: [],
  error: null,
  sessionId: null,
};

test("a run started with a member stores runs.member_id and its token resolves to that member", async () => {
  const x = fixture();
  const org = createOrg(x.db, {
    name: "A",
    slug: "acme",
    ownerUserId: "u",
    ownerName: "O",
    ownerHandle: "owner",
  });
  const member = addAgentMember(x.db, org.id, {
    agentId: "fake",
    handle: "bot",
    displayName: "bot",
    specialties: [],
  });
  const seen: { v: ReturnType<typeof verifyRunToken> } = { v: null };
  const lane = async (ctx: { mcp: { token: string } | null }): Promise<RunOutcome> => {
    seen.v = ctx.mcp ? verifyRunToken(x.db, ctx.mcp.token) : null;
    return done;
  };
  const id = await startRun(x.db, fakeDeps(x, [], { lane }), {
    agentId: "fake",
    repo: x.repo,
    prompt: "go",
    member: { memberId: member.id, orgId: org.id, scopes: ["report", "guard_hook", "board"] },
  });
  const row = await waitForRun(id);
  expect(row.memberId).toBe(member.id);
  expect(seen.v).toEqual({
    runId: id,
    scopes: ["report", "guard_hook", "board"],
    memberId: member.id,
    orgId: org.id,
    candidateId: null,
  });
});

test("a run without a member keeps the default scopes and no member", async () => {
  const x = fixture();
  const seen: { v: ReturnType<typeof verifyRunToken> } = { v: null };
  const lane = async (ctx: { mcp: { token: string } | null }): Promise<RunOutcome> => {
    seen.v = ctx.mcp ? verifyRunToken(x.db, ctx.mcp.token) : null;
    return done;
  };
  const id = await startRun(x.db, fakeDeps(x, [], { lane }), {
    agentId: "fake",
    repo: x.repo,
    prompt: "go",
  });
  expect((await waitForRun(id)).memberId).toBeNull();
  expect(seen.v).toMatchObject({ scopes: ["report", "guard_hook"], memberId: null, orgId: null });
});
