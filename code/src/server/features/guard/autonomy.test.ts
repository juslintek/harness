import type { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { addAgentMember, createOrg, createPosition } from "../orgs/api";
import { setPolicy } from "../policies/api";
import {
  type ActionRequest,
  checkAction,
  decideApproval,
  listApprovals,
  managerDecide,
} from "./api";
import { awaitApproval, createApproval } from "./approvals";

let db: Database;
let orgId: string;
let boss: string;
let dev: string;

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db, migrations);
  orgId = createOrg(db, {
    name: "A",
    slug: "acme",
    ownerUserId: "u",
    ownerName: "O",
    ownerHandle: "owner",
  }).id;
  const agent = (handle: string): string =>
    addAgentMember(db, orgId, { agentId: "a", handle, displayName: handle, specialties: [] }).id;
  boss = agent("boss");
  dev = agent("dev");
  const lead = createPosition(db, { orgId, title: "lead", memberId: boss, isManager: true });
  createPosition(db, { orgId, title: "dev", memberId: dev, reportsTo: lead.id });
});

const scope = { root: "/work/tree", home: "/home/u", defaultBranch: "main" };
const exec = (command: string): ActionRequest => ({ kind: "execute", command, paths: [] });

function runOf(memberId: string | null): { id: string; prompt: string; scope: typeof scope } {
  const id = Bun.randomUUIDv7();
  db.run(
    "INSERT INTO runs (id, member_id, agent_id, repo, prompt, state, created_at) VALUES (?, ?, 'a', '/r', 'p', 'running', 1)",
    [id, memberId],
  );
  return { id, prompt: "p", scope };
}

const strictOrg = (): void => {
  setPolicy(db, { layer: "org", targetId: orgId, key: "autonomy", value: "strict", setBy: "t" });
};

// Starts a check that must stop for a human, and returns what the approval says about L1.
async function asked(run: ReturnType<typeof runOf>, command: string): Promise<string> {
  const pending: string[] = [];
  const outcome = checkAction(db, run, exec(command), {
    onApprovalPending: (id) => pending.push(id),
  });
  for (let i = 0; i < 200 && pending.length === 0; i++) await Bun.sleep(10);
  expect(pending).toHaveLength(1);
  const [approval] = listApprovals(db, "pending");
  decideApproval(db, pending[0] as string, "deny", "u");
  expect((await outcome).verdict).toBe("deny");
  return approval?.l1 ?? "";
}

test("strict autonomy asks for anything that is not a read and leaves reads alone", async () => {
  strictOrg();
  const run = runOf(dev);
  expect((await checkAction(db, run, exec("git status"))).verdict).toBe("allow");
  const l1 = await asked(run, "touch x");
  expect(JSON.parse(l1)).toMatchObject({ verdict: "ask", reason: "autonomy strict (org)" });
});

test("without the policy the same command does not ask a human", async () => {
  const outcome = await checkAction(db, runOf(dev), exec("touch x"), { approvalTimeoutMs: 50 });
  expect(outcome.layer).not.toBe("L3");
});

test("strict never turns a denial into an ask, and a run with no member is unaffected", async () => {
  strictOrg();
  const denied = await checkAction(db, runOf(dev), exec("cat ~/.ssh/id_rsa"));
  expect(denied).toMatchObject({ verdict: "deny", layer: "L1" });
  const interview = await checkAction(db, runOf(null), exec("touch x"), { approvalTimeoutMs: 50 });
  expect(interview.layer).not.toBe("L3");
});

test("a looser row below a strict org does not loosen the run", async () => {
  strictOrg();
  db.run(
    "INSERT INTO policies (id, layer, target_id, key, value, set_by, updated_at) VALUES ('p', 'agent', ?, 'autonomy', '\"full\"', 'x', 1)",
    [dev],
  );
  const l1 = await asked(runOf(dev), "touch x");
  expect(JSON.parse(l1).reason).toBe("autonomy strict (org)");
});

function approvalOf(runId: string): { id: string; waiting: Promise<string> } {
  const { id, expiresAt } = createApproval(db, {
    runId,
    action: JSON.stringify({ kind: "execute", command: "bun test", paths: [] }),
    l1: JSON.stringify({ verdict: "ask", rule: "r", reason: "x", category: "shell" }),
    l2: null,
    timeoutMs: 60_000,
  });
  return { id, waiting: awaitApproval(db, id, expiresAt) };
}

test("a manager agent may decide under full autonomy and is refused naming the layer otherwise", async () => {
  const decide = (id: string) =>
    managerDecide(db, {
      approvalId: id,
      managerMemberId: boss,
      harnessHome: "/Users/x/.harness",
      decision: "approve",
      reason: "fine",
    });
  const first = approvalOf(runOf(dev).id);
  expect(decide(first.id)).toEqual({ ok: true });
  expect(await first.waiting).toBe("approved");
  setPolicy(db, {
    layer: "org",
    targetId: orgId,
    key: "autonomy",
    value: "supervised",
    setBy: "t",
  });
  const second = approvalOf(runOf(dev).id);
  expect(decide(second.id)).toEqual({ ok: false, reason: "autonomy is supervised (org)" });
  decideApproval(db, second.id, "deny", "u");
  await second.waiting;
});
