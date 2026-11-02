import { afterAll, expect, test } from "bun:test";
import { verifyRunToken } from "../mcp/api";
import { addAgentMember, createOrg, removeMember } from "../orgs/api";
import type { RunOutcome } from "./adapter";
import { startRun, waitForRun, wireRuntimes } from "./api";
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
