import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import {
  addAgentMember,
  createOrg,
  createPosition,
  createProject,
  grantProject,
} from "../orgs/api";
import { decidableApprovals, managerDecide } from "./api";
import { awaitApproval, createApproval } from "./approvals";
import { type DecideContext, managerMayDecide } from "./manager-limits";

const base: DecideContext = {
  requesterMemberId: "r",
  managerMemberId: "m",
  inSubtree: true,
  ownsProject: true,
  autonomy: null,
  category: "shell",
  rule: null,
  kind: "execute",
  command: "bun test",
  paths: [],
  harnessHome: "/Users/x/.harness",
  exfiltration: 0,
};

test("manager-limits refuses what a manager agent may never decide", () => {
  const refused: Partial<DecideContext>[] = [
    { requesterMemberId: null },
    { exfiltration: 0.9 },
    { exfiltration: 0.97 },
    { requesterMemberId: "m" },
    { inSubtree: false },
    { ownsProject: false },
    { category: "network" },
    { category: "secret" },
    { kind: "fetch" },
    { command: "cat $HARNESS_HOME/harness.db" },
    { command: "ls /Users/x/.harness/runs" },
    { command: "cat ~/.harness/harness.db" },
    { command: "cat accounts/acc-1/auth.json" },
    { command: "cat ../../accounts/acc-1/auth.json" },
    { paths: ["accounts/acc-1/auth.json"] },
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
  expect(managerMayDecide({ ...base, exfiltration: 0.89 })).toBeNull();
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

function ask(
  db: ReturnType<typeof openDb>,
  memberId: string | null,
  command: string,
  l2: string | null = null,
) {
  const runId = Bun.randomUUIDv7();
  db.run(
    "INSERT INTO runs (id, member_id, agent_id, repo, prompt, state, created_at) VALUES (?, ?, 'a', '/r', 'p', 'running', 1)",
    [runId, memberId],
  );
  const { id, expiresAt } = createApproval(db, {
    runId,
    action: JSON.stringify({ kind: "execute", command, paths: [] }),
    l1: JSON.stringify({ verdict: "ask", rule: "r", reason: "x", category: "shell" }),
    l2,
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

test("an approval Laya flagged for exfiltration is left to a human", () => {
  const { db, boss, dev } = setup();
  const l2 = (exfiltration: number) =>
    JSON.stringify({ verdict: "ask", reason: "x", source: "laya", probs: { exfiltration } });
  const flagged = ask(db, dev, "npm publish", l2(0.93));
  const calm = ask(db, dev, "npm test", l2(0.2));
  expect(decidableApprovals(db, boss, HOME).map((x) => x.id)).toEqual([calm.id]);
  const input = { harnessHome: HOME, managerMemberId: boss, decision: "approve" as const };
  expect(managerDecide(db, { ...input, approvalId: flagged.id, reason: "ok" })).toEqual({
    ok: false,
    reason: "laya flagged possible exfiltration",
  });
});

test("a grantee org's manager cannot decide a run against the owner's project", () => {
  const { db, boss, dev } = setup();
  const owner = createOrg(db, {
    name: "B",
    slug: "beta",
    ownerUserId: "u2",
    ownerName: "O2",
    ownerHandle: "owner2",
  });
  const project = createProject(db, { orgId: owner.id, key: "web", name: "Web" });
  const ownerMember = db
    .query<{ id: string }, [string]>("SELECT id FROM members WHERE org_id = ?")
    .get(owner.id)?.id as string;
  const acme = db
    .query<{ org_id: string }, [string]>("SELECT org_id FROM members WHERE id = ?")
    .get(boss)?.org_id as string;
  grantProject(db, project.id, acme, "write", ownerMember);
  const a = ask(db, dev, "bun test");
  db.run("UPDATE runs SET project_id = ? WHERE id = ?", [project.id, a.runId]);
  expect(decidableApprovals(db, boss, HOME)).toEqual([]);
  const input = { harnessHome: HOME, managerMemberId: boss, decision: "approve" as const };
  expect(managerDecide(db, { ...input, approvalId: a.id, reason: "ok" })).toEqual({
    ok: false,
    reason: "the run works on another org's project; a human must decide",
  });
});
