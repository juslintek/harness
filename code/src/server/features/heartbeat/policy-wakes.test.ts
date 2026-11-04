import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { createPosition } from "../orgs/api";
import { decideProposal, propose, review } from "../policies/api";
import { setup, until, wakes } from "./kit";

setDefaultTimeout(30_000);

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

test("reviewers are woken once, and the proposer when the proposal is decided", async () => {
  const k = setup();
  const dev = k.agent("dev");
  const boss = k.agent("boss");
  const peer = k.agent("peer");
  const lead = createPosition(k.db, {
    orgId: k.orgId,
    title: "lead",
    memberId: boss.id,
    isManager: true,
  });
  createPosition(k.db, { orgId: k.orgId, title: "dev", memberId: dev.id, reportsTo: lead.id });
  stops.push(k.start());
  const proposal = propose(k.db, {
    orgId: k.orgId,
    memberId: dev.id,
    key: "autonomy",
    value: "strict",
    reason: "careful",
    reviewers: [boss.id, peer.id],
  });
  await until(() => wakes(k.db, boss.id).length === 1 && wakes(k.db, peer.id).length === 1);
  const [woken] = wakes(k.db, boss.id);
  expect(woken?.reason).toBe("policy_review");
  expect(woken?.detail).toContain(proposal.id);
  await until(() => k.seen.some((s) => s.prompt.includes("`policy_review {proposal")));

  review(k.db, { proposalId: proposal.id, reviewerId: boss.id, verdict: "approve", comment: "ok" });
  await Bun.sleep(100);
  expect(wakes(k.db, peer.id)).toHaveLength(1);
  expect(wakes(k.db, boss.id)).toHaveLength(1);

  const decided = decideProposal(k.db, {
    proposalId: proposal.id,
    decidedBy: { kind: "agent", memberId: boss.id },
    decision: "approve",
    reason: "fine",
  });
  expect(decided).toEqual({ ok: true });
  await until(() => wakes(k.db, dev.id).length === 1);
  const [resolved] = wakes(k.db, dev.id);
  expect(resolved?.reason).toBe("approval_resolved");
  expect(JSON.parse(resolved?.detail as string)).toMatchObject({
    kind: "policy",
    outcome: "approved",
  });
});
