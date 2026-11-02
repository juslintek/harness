import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { addAgentMember, createOrg, createPosition } from "../orgs/api";
import { decidableApprovals, managerDecide } from "./api";
import { awaitApproval, createApproval } from "./approvals";
import { type DecideContext, managerMayDecide } from "./manager-limits";

const base: DecideContext = {
  requesterMemberId: "r",
  managerMemberId: "m",
  inSubtree: true,
  category: "shell",
  rule: null,
  kind: "execute",
  command: "bun test",
  paths: [],
  harnessHome: "/Users/x/.harness",
};

test("manager-limits refuses what a manager agent may never decide", () => {
  const refused: Partial<DecideContext>[] = [
    { requesterMemberId: null },
    { requesterMemberId: "m" },
    { inSubtree: false },
    { category: "network" },
    { category: "secret" },
    { kind: "fetch" },
    { command: "cat $HARNESS_HOME/harness.db" },
    { command: "ls /Users/x/.harness/runs" },
    { command: "cat ~/.harness/harness.db" },
    { command: "cat $HOME/.harness/secrets.json" },
    { command: `cat $\{HOME}/.harness/secrets.json` },
    { command: "cat /repo/../../Users/x/.harness/x" },
    { command: "cat /Users/x/./.harness//x" },
    { kind: "read", command: "", paths: ["/repo/../Users/x/.harness/harness.db"] },
    { harnessHome: "~/foo".replace("~", "/Users/x"), command: "cat /Users/x/foo/db" },
    { command: "cat features/guard/l1.ts" },
    { command: "cat features/./guard/l1.ts" },
    { command: "cat features//auth/admin.ts" },
    { command: "cat src/server/features/x/../policies/p.ts" },
    { kind: "edit", command: "", paths: ["features/guard/l1.ts"] },
    { rule: "write.outside-root" },
    { rule: "read.outside-root" },
    { rule: "exec.escalate" },
    { rule: "env.injection" },
    { kind: "edit", command: "", paths: ["/repo/src/server/features/guard/l1.ts"] },
    { command: "bun run deploy" },
    { command: "srt --settings x sh" },
    { command: "echo hi > .claude/settings.json" },
    { command: "cat ~/.codex/config.toml" },
    { command: "git push origin 'main'" },
    { command: 'git push origin "main"' },
    { command: "git push origin ma\\in" },
    { command: "git push origin *" },
    { command: "git push origin ma?n" },
    { command: "git push origin [m]ain" },
    { command: "git push origin {main,dev}" },
    { command: "git push origin $BRANCH" },
    { command: "git push origin `echo main`" },
    { command: "cd /tmp && git push origin main" },
    { command: "git status; cd .. ; git push" },
  ];
  for (const change of refused) {
    expect(managerMayDecide({ ...base, ...change })).toEqual(expect.any(String));
  }
  expect(managerMayDecide({ ...base, command: "git push origin main" })).toBeNull();
  expect(managerMayDecide({ ...base, command: "abcd e" })).toBeNull();
  expect(managerMayDecide({ ...base, command: "$(x)" })).toBe(
    "command uses shell indirection; a human must decide",
  );
  expect(managerMayDecide(base)).toBeNull();
  expect(managerMayDecide({ ...base, category: "git_push", rule: "git.push" })).toBeNull();
});

const HOME = "/Users/x/.harness";

function setup() {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const org = createOrg(db, {
    name: "A",
    slug: "acme",
    ownerUserId: "u",
    ownerName: "O",
    ownerHandle: "owner",
  });
  const agent = (handle: string) =>
    addAgentMember(db, org.id, { agentId: "a", handle, displayName: handle, specialties: [] }).id;
  const [boss, dev, peer] = [agent("boss"), agent("dev"), agent("peer")] as [
    string,
    string,
    string,
  ];
  const lead = createPosition(db, {
    orgId: org.id,
    title: "lead",
    memberId: boss,
    isManager: true,
  });
  createPosition(db, { orgId: org.id, title: "dev", memberId: dev, reportsTo: lead.id });
  createPosition(db, { orgId: org.id, title: "peer", memberId: peer });
  return { db, boss, dev, peer };
}

function ask(db: ReturnType<typeof openDb>, memberId: string | null, command: string) {
  const runId = Bun.randomUUIDv7();
  db.run(
    "INSERT INTO runs (id, member_id, agent_id, repo, prompt, state, created_at) VALUES (?, ?, 'a', '/r', 'p', 'running', 1)",
    [runId, memberId],
  );
  const { id, expiresAt } = createApproval(db, {
    runId,
    action: JSON.stringify({ kind: "execute", command, paths: [] }),
    l1: JSON.stringify({ verdict: "ask", rule: "r", reason: "x", category: "shell" }),
    l2: null,
    timeoutMs: 60_000,
  });
  return { runId, id, waiting: awaitApproval(db, id, expiresAt) };
}

test("managerDecide resolves a waiting approval and the guard event carries source manager_agent", async () => {
  const { db, boss, dev, peer } = setup();
  const a = ask(db, dev, "bun test");
  expect(decidableApprovals(db, boss, HOME).map((x) => x.id)).toEqual([a.id]);
  expect(decidableApprovals(db, peer, HOME)).toEqual([]);

  const input = {
    approvalId: a.id,
    harnessHome: HOME,
    managerMemberId: boss,
    decision: "approve" as const,
    reason: "safe",
  };
  expect(managerDecide(db, { ...input, managerMemberId: peer }).ok).toBe(false);
  expect(managerDecide(db, input)).toEqual({ ok: true });
  expect(await a.waiting).toBe("approved");
  expect(managerDecide(db, input)).toEqual({ ok: false, reason: "not pending" });

  const event = db
    .query<
      { source: string; guard_layer: string; guard_rule: string; guard_verdict: string },
      [string]
    >("SELECT source, guard_layer, guard_rule, guard_verdict FROM events WHERE run_id = ?")
    .get(a.runId);
  expect(event).toEqual({
    source: "manager_agent",
    guard_layer: "L3",
    guard_rule: "safe",
    guard_verdict: "allow",
  });
  const row = db
    .query<{ decided_by: string }, [string]>("SELECT decided_by FROM approvals WHERE id = ?")
    .get(a.id);
  expect(row?.decided_by).toBe(`agent:${boss}`);
});

test("managerDecide refuses a run without a member and an unknown approval", () => {
  const { db, boss } = setup();
  const a = ask(db, null, "bun test");
  const input = {
    harnessHome: HOME,
    managerMemberId: boss,
    decision: "deny" as const,
    reason: "no",
  };
  expect(managerDecide(db, { ...input, approvalId: a.id }).ok).toBe(false);
  expect(managerDecide(db, { ...input, approvalId: "nope" }).ok).toBe(false);
});
