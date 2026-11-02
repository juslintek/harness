import { afterAll, expect, test } from "bun:test";
import { verifyRunToken } from "../mcp/api";
import {
  addAgentMember,
  createOrg,
  createProject,
  grantProject,
  removeMember,
  revokeGrant,
} from "../orgs/api";
import type { RunOutcome } from "./adapter";
import { getRun, startRun, waitForRun, wireRuntimes } from "./api";
import { cleanup, fakeDeps, fixture } from "./manager-kit";

afterAll(cleanup);

const done: RunOutcome = {
  stopReason: "end_turn",
  text: "",
  usage: [],
  error: null,
  sessionId: null,
};

test("removing an agent member kills its live run and revokes the run token, others keep running", async () => {
  wireRuntimes();
  const x = fixture();
  const org = createOrg(x.db, {
    name: "A",
    slug: "acme",
    ownerUserId: "u",
    ownerName: "O",
    ownerHandle: "owner",
  });
  const agent = (handle: string) =>
    addAgentMember(x.db, org.id, { agentId: "fake", handle, displayName: handle, specialties: [] });
  const [doomed, keeper] = [agent("doomed"), agent("keeper")] as const;
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tokens: Record<string, string> = {};
  const lane = async (ctx: {
    mcp: { token: string } | null;
    signal: AbortSignal;
    prompt: string;
  }): Promise<RunOutcome> => {
    tokens[ctx.prompt] = ctx.mcp?.token ?? "";
    if (ctx.prompt === "doomed") {
      await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
    } else await gate;
    return done;
  };
  const start = (member: typeof doomed) =>
    startRun(x.db, fakeDeps(x, [], { lane }), {
      agentId: "fake",
      repo: x.repo,
      prompt: member.handle,
      member: { memberId: member.id, orgId: org.id, scopes: ["report", "board"] },
    });
  const [doomedRun, keeperRun] = [await start(doomed), await start(keeper)];
  while (!tokens.doomed || !tokens.keeper) await Bun.sleep(10);
  expect(verifyRunToken(x.db, tokens.doomed ?? "")).not.toBeNull();
  removeMember(x.db, doomed.id);
  const row = await waitForRun(doomedRun);
  expect([row.state, row.reason]).toEqual(["killed", "member_removed"]);
  expect(verifyRunToken(x.db, tokens.doomed ?? "")).toBeNull();
  expect(verifyRunToken(x.db, tokens.keeper ?? "")).not.toBeNull();
  release();
  expect((await waitForRun(keeperRun)).state).toBe("completed");
});

test("lowering or revoking a grant kills the grantee org's live runs in that project, not the owner's", async () => {
  wireRuntimes();
  const x = fixture();
  const mk = (slug: string) =>
    createOrg(x.db, {
      name: slug,
      slug,
      ownerUserId: slug,
      ownerName: slug,
      ownerHandle: slug,
    });
  const [owner, guest] = [mk("owner"), mk("guest")] as const;
  const agent = (orgId: string, handle: string) =>
    addAgentMember(x.db, orgId, { agentId: "fake", handle, displayName: handle, specialties: [] });
  const [own, visitor] = [agent(owner.id, "own"), agent(guest.id, "visitor")] as const;
  const project = createProject(x.db, { orgId: owner.id, key: "web", name: "Web" });
  const granter = agent(owner.id, "granter").id;
  grantProject(x.db, project.id, guest.id, "write", granter);
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lane = async (ctx: { signal: AbortSignal; prompt: string }): Promise<RunOutcome> => {
    if (ctx.prompt === "own") await gate;
    else
      await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
    return done;
  };
  const start = (member: typeof own, orgId: string) =>
    startRun(x.db, fakeDeps(x, [], { lane }), {
      agentId: "fake",
      repo: x.repo,
      prompt: member.handle,
      member: { memberId: member.id, orgId, scopes: ["report"], projectId: project.id },
    });
  const ownRun = await start(own, owner.id);
  const first = await start(visitor, guest.id);
  grantProject(x.db, project.id, guest.id, "write", granter);
  expect(getRun(x.db, first)?.endedAt).toBeNull();
  grantProject(x.db, project.id, guest.id, "read", granter);
  const lowered = await waitForRun(first);
  expect([lowered.state, lowered.reason]).toEqual(["killed", "grant_changed"]);
  grantProject(x.db, project.id, guest.id, "write", granter);
  const second = await start(visitor, guest.id);
  revokeGrant(x.db, project.id, guest.id);
  expect((await waitForRun(second)).reason).toBe("grant_changed");
  release();
  expect((await waitForRun(ownRun)).state).toBe("completed");
});
