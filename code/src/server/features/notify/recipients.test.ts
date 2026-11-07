import { expect, test } from "bun:test";
import type { ApprovalView } from "../../../shared/runs";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { bootApi } from "../../test-support/api-kit";
import { seedMember } from "../../test-support/bridge-kit";
import { addAgentMember, createProject, grantProject } from "../orgs/api";
import { approvalRecipients, runOrgId } from "./recipients";

test("a run's org comes from the project, then the stamped org, then the member", () => {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const a = seedMember(db, "alice");
  const b = seedMember(db, "bob");
  const project = createProject(db, { orgId: b.orgId, key: "web", name: "Web" });
  const insert = (id: string, org: string | null, member: string | null, proj: string | null) =>
    db.run(
      "INSERT INTO runs (id, org_id, member_id, project_id, agent_id, repo, prompt, state, created_at) VALUES (?, ?, ?, ?, 'a', '/r', 'p', 'running', 1)",
      [id, org, member, proj],
    );
  insert("stamped", a.orgId, a.memberId, project.id);
  insert("project", null, a.memberId, project.id);
  insert("stamp-only", b.orgId, a.memberId, null);
  insert("member", null, a.memberId, null);
  insert("orphan", null, null, null);
  expect(runOrgId(db, "stamped")).toBe(b.orgId);
  expect(runOrgId(db, "project")).toBe(b.orgId);
  expect(runOrgId(db, "stamp-only")).toBe(b.orgId);
  expect(runOrgId(db, "member")).toBe(a.orgId);
  expect(runOrgId(db, "orphan")).toBeNull();
  expect(runOrgId(db, "missing")).toBeNull();
});

test("shared-project approval recipients can open the approval, agent-org admins are excluded", async () => {
  const k = bootApi();
  const agentOwner = await k.user();
  const projectOwner = await k.user();
  const instanceAdmin = await k.user({ admin: true });
  const projectAdmin = await k.user();
  const orgA = k.org(agentOwner, "agent-org");
  const orgB = k.org(projectOwner, "project-org");
  const root = k.join(orgA.id, instanceAdmin, "member", "root");
  const admin = k.join(orgB.id, projectAdmin, "admin", "admin");
  const agent = addAgentMember(k.db, orgA.id, {
    agentId: "a",
    handle: "bot",
    displayName: "Bot",
    specialties: [],
  });
  const project = createProject(k.db, { orgId: orgB.id, key: "web", name: "Web" });
  grantProject(k.db, project.id, orgA.id, "write", orgB.owner.id);
  k.db.run(
    "INSERT INTO runs (id, org_id, member_id, project_id, agent_id, repo, prompt, state, created_at) VALUES ('run', ?, ?, ?, 'a', '/r', 'p', 'running', 1)",
    [orgA.id, agent.id, project.id],
  );
  k.db.run(
    "INSERT INTO approvals (id, run_id, action, l1, status, created_at, expires_at) VALUES ('approval', 'run', ?, '{}', 'pending', 1, ?)",
    [JSON.stringify({ kind: "execute", command: "git push", paths: [] }), Date.now() + 60_000],
  );
  const path = "/api/approvals/approval";
  const response = await k.call(projectOwner, "GET", path);
  expect(response.status).toBe(200);
  const approval = (await response.json()) as ApprovalView;
  expect(approvalRecipients(k.db, approval).sort()).toEqual(
    [orgB.owner.id, admin.id, root.id].sort(),
  );
  expect((await k.call(projectAdmin, "GET", path)).status).toBe(200);
  expect((await k.call(instanceAdmin, "GET", path)).status).toBe(200);
  expect((await k.call(agentOwner, "GET", path)).status).toBe(404);
});
